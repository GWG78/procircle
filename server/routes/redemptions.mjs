// routes/redemptions.mjs
import express from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { PrismaClient } from "@prisma/client";
import { getOffersForMember, checkEligibility } from "../services/eligibilityService.js";
import { getOrCreateCustomer, addMemberToCampaignDiscount } from "../services/shopifyCustomerService.js";
import { triggerCodeEmail } from "../services/makeWebhookService.js";

const prisma = new PrismaClient();
const router = express.Router();

// This route has no caller identity to verify — it's hit by an anonymous,
// external member-facing flow with no session/token of any kind (see
// verifyShopifyAuth, which only applies to the embedded-admin campaigns
// routes). Left intentionally public; these two limiters are abuse
// protection, not authentication. IP limiter catches scripted hammering;
// email limiter catches someone spamming a single member's inbox with
// redemption emails or brute-forcing a campaign's redemption cap via one
// address. Both are in-memory (single web dyno, per render.yaml) — fine
// for abuse protection, not a substitute for real rate limiting infra if
// this app is ever scaled beyond one instance.
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

    // Everything below is a side effect (Shopify + email). Failures here are
    // operational, not user-facing: mark the Redemption failed and log it,
    // but always tell the member their code is on its way.
    try {
      const shopifyCustomerId = await getOrCreateCustomer(campaign.shop, member);
      await addMemberToCampaignDiscount(campaign.shop, campaign, shopifyCustomerId);

      await triggerCodeEmail({
        memberEmail: member.email,
        discountLink: campaign.discountLink,
        campaignName: campaign.name,
        brandName: campaign.shop.shopDomain,
      });

      await prisma.redemption.update({
        where: { id: redemption.id },
        data: { status: "confirmed" },
      });
    } catch (err) {
      console.error(`❌ Redemption ${redemption.id} fulfillment failed:`, err);
      try {
        await prisma.redemption.update({
          where: { id: redemption.id },
          data: { status: "failed" },
        });
      } catch (updateErr) {
        console.error(`❌ Failed to mark redemption ${redemption.id} as failed:`, updateErr);
      }
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

    const offers = await getOffersForMember(member);
    return res.json({ success: true, offers });
  } catch (err) {
    console.error("❌ Error loading offers:", err);
    return res.status(500).json({ success: false, error: "Failed to load offers" });
  }
});

export default router;
