// routes/redemptions.mjs
import express from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { PrismaClient } from "@prisma/client";
import { getOffersForMember, checkEligibility } from "../services/eligibilityService.js";
import { getOrCreateCustomer, addMemberToCampaignDiscount } from "../services/shopifyCustomerService.js";
import { sendCodeEmail } from "../services/resendService.js";
import { getOrFetchShopName } from "../services/shopService.js";
import { logDataAccess } from "../utils/accessLog.js";

const prisma = new PrismaClient();
const router = express.Router();

// Shared-secret check, same pattern (and same env var) as routes/members.mjs
// — WordPress is the only legitimate caller of this router now (it proxies
// both routes server-side, never exposing the secret to the browser). Before
// this, both routes were fully public with no caller-identity check at all;
// that meant anyone who knew a real member's email could trigger a real
// redemption (Shopify audience-add + code email) for them without consent.
router.use((req, res, next) => {
  const token = req.headers["x-api-key"];
  if (!token || token !== process.env.GOOGLE_SHEET_SECRET) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }
  next();
});

// The rate limiters below stay as defense-in-depth even with the secret
// check above — IP limiter catches scripted hammering; email limiter
// catches someone spamming a single member's inbox with redemption emails
// or brute-forcing a campaign's redemption cap via one address. Both are
// in-memory (single web dyno, per render.yaml) — fine for abuse
// protection, not a substitute for real rate limiting infra if this app
// is ever scaled beyond one instance.
const ipLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: "Too many requests. Please try again later." },
});

const emailLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => String(req.body?.memberEmail || "").trim().toLowerCase() || ipKeyGenerator(req.ip),
  message: { success: false, error: "Too many requests for this email. Please try again later." },
});

/* ============================================================
   POST /api/redemptions/request
   ============================================================ */
router.post("/request", ipLimiter, emailLimiter, async (req, res) => {
  try {
    const { memberEmail, campaignId } = req.body || {};

    if (!memberEmail || campaignId == null) {
      return res.status(400).json({ success: false, error: "memberEmail and campaignId are required" });
    }

    const numericCampaignId = Number(campaignId);
    if (isNaN(numericCampaignId)) {
      return res.status(400).json({ success: false, error: "campaignId must be a number" });
    }

    const cleanEmail = String(memberEmail).trim().toLowerCase();
    const member = await prisma.member.findUnique({ where: { email: cleanEmail } });
    if (!member) {
      return res.status(404).json({ success: false, error: "Member not found" });
    }

    const campaign = await prisma.campaign.findUnique({
      where: { id: numericCampaignId },
      include: { shop: true, filters: true },
    });
    if (!campaign) {
      return res.status(404).json({ success: false, error: "Campaign not found" });
    }

    logDataAccess({
      action: 'READ',
      dataType: 'Member',
      shop: campaign.shop.shopDomain,
      requestedBy: 'wordpress-server',
      recordCount: 1,
      fields: ['email', 'firstName', 'lastName', 'role', 'country', 'resort', 'verified'],
    });

    const check = await checkEligibility(member, campaign.id);
    if (!check.eligible) {
      if (check.reason === "cap_reached") {
        return res.status(200).json({ status: "fully_claimed", message: "Check back soon" });
      }
      return res.status(403).json({ success: false, reason: check.reason });
    }

    // Create the Redemption inside a transaction that re-counts confirmed
    // redemptions first, guarding against a race with other in-flight requests.
    let txResult;
    try {
      txResult = await prisma.$transaction(async (tx) => {
        const confirmedCount = await tx.redemption.count({
          where: { campaignId: campaign.id, status: "confirmed" },
        });

        if (campaign.maxRedemptions != null && confirmedCount >= campaign.maxRedemptions) {
          return { capReached: true };
        }

        const accessExpiresAt = new Date();
        accessExpiresAt.setDate(accessExpiresAt.getDate() + campaign.validForDays);

        const redemption = await tx.redemption.create({
          data: {
            campaignId: campaign.id,
            memberId: member.id,
            status: "pending",
            accessGrantedAt: new Date(),
            accessExpiresAt,
          },
        });

        return { capReached: false, redemption };
      });
    } catch (err) {
      console.error("❌ Redemption transaction failed:", err);
      return res.status(500).json({ success: false, error: "Failed to create redemption" });
    }

    if (txResult.capReached) {
      return res.status(200).json({ status: "fully_claimed", message: "Check back soon" });
    }

    const redemption = txResult.redemption;

    // Stage 1: grant Shopify access. A failure here is real — the member
    // does NOT actually have access — so it must be reported as an error,
    // not silently swallowed into the same "confirmed" response as a mere
    // email-delivery failure (which is what this used to do; a Shopify
    // failure and an email failure were previously indistinguishable to
    // the caller, both just resulting in "You'll receive your code by
    // email shortly" even when that was false).
    try {
      const shopifyCustomerId = await getOrCreateCustomer(campaign.shop, member);
      await addMemberToCampaignDiscount(campaign.shop, campaign, shopifyCustomerId);
    } catch (err) {
      console.error(`❌ Redemption ${redemption.id} Shopify fulfillment failed:`, err);
      try {
        await prisma.redemption.update({
          where: { id: redemption.id },
          data: { status: "failed" },
        });
      } catch (updateErr) {
        console.error(`❌ Failed to mark redemption ${redemption.id} as failed:`, updateErr);
      }
      return res.status(500).json({ success: false, error: "Failed to grant discount access. Please try again." });
    }

    // Stage 2: email the code. Best-effort — access is already granted by
    // this point, so this must never turn a real access-grant into an
    // error response. sendCodeEmail never throws even on failure (see
    // resendService.js) — a missing/failed Resend call is logged there
    // with an [ALERT] tag and nothing more; it's surfaced to whoever
    // monitors Render's logs, not to the member.
    const brandName = await getOrFetchShopName(campaign.shopId);
    await sendCodeEmail({
      memberEmail: member.email,
      memberFirstName: member.firstName,
      discountAmount: `${campaign.discountValue}%`,
      discountCode: campaign.discountCode,
      discountLink: campaign.discountLink,
      campaignName: campaign.name,
      brandName,
    });

    try {
      await prisma.redemption.update({
        where: { id: redemption.id },
        data: { status: "confirmed" },
      });
    } catch (err) {
      console.error(`❌ Failed to mark redemption ${redemption.id} as confirmed:`, err);
    }

    return res.status(200).json({
      status: "confirmed",
      message: "You'll receive your code by email shortly",
    });
  } catch (err) {
    console.error("❌ Redemption request error:", err);
    return res.status(500).json({ success: false, error: "Redemption request failed" });
  }
});

/* ============================================================
   GET /api/redemptions/offers?email=
   ============================================================ */
router.get("/offers", async (req, res) => {
  try {
    const { email } = req.query;
    if (!email) {
      return res.status(400).json({ success: false, error: "email is required" });
    }

    const cleanEmail = String(email).trim().toLowerCase();
    const member = await prisma.member.findUnique({ where: { email: cleanEmail } });
    if (!member) {
      return res.status(404).json({ success: false, error: "Member not found" });
    }

    // Not shop-scoped — offers span every shop the member could redeem
    // from, not one shop's data.
    logDataAccess({
      action: 'READ',
      dataType: 'Member',
      shop: null,
      requestedBy: 'wordpress-server',
      recordCount: 1,
      fields: ['email', 'firstName', 'lastName', 'role', 'country', 'resort', 'verified'],
    });

    const offers = await getOffersForMember(member);
    return res.json({ success: true, offers });
  } catch (err) {
    console.error("❌ Error loading offers:", err);
    return res.status(500).json({ success: false, error: "Failed to load offers" });
  }
});

export default router;
