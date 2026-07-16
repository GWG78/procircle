// server/routes/campaigns.mjs
import express from "express";
import { PrismaClient } from "@prisma/client";
import { createCampaignDiscount } from "../services/discountLinkService.js";

const prisma = new PrismaClient();
const router = express.Router();

/**
 * lowercase, spaces -> hyphens, strip anything that isn't a-z/0-9/hyphen,
 * collapse repeated hyphens. Falls back to "campaign" if the name is
 * entirely non-alphanumeric (e.g. emoji-only names).
 */
function slugify(name) {
  const base = String(name)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  return base || "campaign";
}

/**
 * Appends a short base36 timestamp suffix until the slug is free.
 */
async function uniqueSlug(name) {
  const base = slugify(name);
  let candidate = base;

  while (await prisma.campaign.findUnique({ where: { slug: candidate } })) {
    const suffix = Date.now().toString(36).slice(-4);
    candidate = `${base}-${suffix}`;
  }

  return candidate;
}

function deriveStatus(campaign) {
  if (!campaign.active) return "inactive";
  if (campaign.expiresAt && new Date(campaign.expiresAt) < new Date()) return "expired";
  return "active";
}

/**
 * ===========================================================
 * POST /api/campaigns/create?shop=...
 * ===========================================================
 */
router.post("/create", async (req, res) => {
  let createdCampaignId = null;

  try {
    const shopDomain = req.query.shop;
    if (!shopDomain) {
      return res.status(400).json({ success: false, error: "shop is required" });
    }

    const shop = await prisma.shop.findUnique({ where: { shopDomain } });
    if (!shop) {
      return res.status(404).json({ success: false, error: "Shop not found" });
    }

    const {
      name,
      discountType,
      discountValue,
      startsAt,
      expiresAt,
      maxRedemptions,
      maxRedemptionsPerUser,
      filters,
    } = req.body || {};

    if (!name || typeof name !== "string" || !name.trim()) {
      return res.status(400).json({ success: false, error: "name is required" });
    }

    const numericDiscountValue = Number(discountValue);
    if (!discountValue || isNaN(numericDiscountValue) || numericDiscountValue <= 0) {
      return res.status(400).json({ success: false, error: "discountValue must be a positive number" });
    }

    const cleanFilters = Array.isArray(filters)
      ? filters
          .filter((f) => f && typeof f.filterType === "string" && typeof f.value === "string")
          .map((f) => ({ filterType: f.filterType.trim(), value: f.value.trim() }))
      : [];

    const slug = await uniqueSlug(name);

    // 1. Create the Campaign + its filters.
    const campaign = await prisma.$transaction(async (tx) => {
      const created = await tx.campaign.create({
        data: {
          shopId: shop.id,
          name: name.trim(),
          slug,
          discountType: discountType === "fixed" ? "fixed" : "percentage",
          discountValue: numericDiscountValue,
          startsAt: startsAt ? new Date(startsAt) : null,
          expiresAt: expiresAt ? new Date(expiresAt) : null,
          maxRedemptions: maxRedemptions != null && maxRedemptions !== "" ? Number(maxRedemptions) : null,
          maxRedemptionsPerUser:
            maxRedemptionsPerUser != null && maxRedemptionsPerUser !== ""
              ? Number(maxRedemptionsPerUser)
              : 1,
        },
      });

      if (cleanFilters.length) {
        await tx.campaignFilter.createMany({
          data: cleanFilters.map((f) => ({
            campaignId: created.id,
            filterType: f.filterType,
            value: f.value,
          })),
        });
      }

      return created;
    });

    createdCampaignId = campaign.id;

    // 2. Create the backing Shopify discount. If this fails, the campaign
    // is useless (no link to share) — roll it back rather than leaving an
    // orphaned campaign with no discount.
    let discountResult;
    try {
      discountResult = await createCampaignDiscount(shop, campaign);
    } catch (err) {
      console.error(`❌ createCampaignDiscount failed for campaign ${campaign.id}:`, err);

      await prisma.$transaction([
        prisma.campaignFilter.deleteMany({ where: { campaignId: campaign.id } }),
        prisma.campaign.delete({ where: { id: campaign.id } }),
      ]);

      return res.status(500).json({
        success: false,
        error: "Failed to create the Shopify discount for this campaign. The campaign was not saved.",
        details: err.message,
      });
    }

    // 3. Persist the discount info and return the full campaign.
    const updated = await prisma.campaign.update({
      where: { id: campaign.id },
      data: {
        discountCode: discountResult.discountCode,
        discountLink: discountResult.discountLink,
        shopifyDiscountId: discountResult.shopifyDiscountId,
      },
      include: { filters: true },
    });

    res.json({ success: true, campaign: updated });
  } catch (err) {
    console.error("❌ Campaign creation error:", err);

    // Best-effort cleanup if we got as far as creating the row but hit an
    // unexpected error before responding.
    if (createdCampaignId) {
      try {
        await prisma.$transaction([
          prisma.campaignFilter.deleteMany({ where: { campaignId: createdCampaignId } }),
          prisma.campaign.delete({ where: { id: createdCampaignId } }),
        ]);
      } catch (cleanupErr) {
        console.error(`❌ Failed to clean up campaign ${createdCampaignId}:`, cleanupErr);
      }
    }

    res.status(500).json({ success: false, error: "Campaign creation failed" });
  }
});

/**
 * ===========================================================
 * GET /api/campaigns?shop=...
 * ===========================================================
 */
router.get("/", async (req, res) => {
  try {
    const shopDomain = req.query.shop;
    if (!shopDomain) {
      return res.status(400).json({ success: false, error: "shop is required" });
    }

    const shop = await prisma.shop.findUnique({ where: { shopDomain } });
    if (!shop) {
      return res.status(404).json({ success: false, error: "Shop not found" });
    }

    const campaigns = await prisma.campaign.findMany({
      where: { shopId: shop.id },
      orderBy: { createdAt: "desc" },
      include: {
        filters: true,
        redemptions: { select: { status: true } },
      },
    });

    const shaped = campaigns.map(({ redemptions, ...campaign }) => ({
      ...campaign,
      status: deriveStatus(campaign),
      _count: { redemptions: redemptions.length },
      confirmedRedemptions: redemptions.filter((r) => r.status === "confirmed").length,
    }));

    res.json({ success: true, campaigns: shaped });
  } catch (err) {
    console.error("❌ Error loading campaigns:", err);
    res.status(500).json({ success: false, error: "Failed to load campaigns" });
  }
});

export default router;
