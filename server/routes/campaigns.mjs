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
 * Shapes a Campaign row (with `filters` and `redemptions` included) into
 * the response shape the UI expects: derived `status`, total redemption
 * `_count`, and a separate `confirmedRedemptions` count. Shared by every
 * route that returns campaign objects so the shape stays consistent.
 */
function shapeCampaign(campaign) {
  const { redemptions = [], ...rest } = campaign;
  return {
    ...rest,
    status: deriveStatus(rest),
    _count: { redemptions: redemptions.length },
    confirmedRedemptions: redemptions.filter((r) => r.status === "confirmed").length,
  };
}

function groupFiltersByType(filters) {
  const map = {};
  for (const f of filters) {
    if (!map[f.filterType]) map[f.filterType] = new Set();
    map[f.filterType].add(f.value);
  }
  return map;
}

/**
 * Checks whether activating `campaignId` would create an audience overlap
 * with any other currently active (non-expired) campaign on `shopId`.
 *
 * Loose rule: two campaigns conflict if, for every filterType that BOTH
 * campaigns filter on, their value sets intersect. A filterType only one
 * side filters on is ignored (that side accepts all values for it), and if
 * the two campaigns share no filterType at all there's no basis to compare
 * them, so no conflict is reported — this means a campaign with zero
 * filters ("all members") never conflicts with anything under this rule,
 * since it has no filterType to share with the other campaign.
 *
 * Returns { id, name } of the first conflicting campaign found, or null.
 */
async function checkAudienceConflict(campaignId, shopId) {
  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    include: { filters: true },
  });
  if (!campaign) return null;

  const now = new Date();
  const otherActiveCampaigns = await prisma.campaign.findMany({
    where: {
      shopId,
      id: { not: campaignId },
      active: true,
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
    include: { filters: true },
    orderBy: { id: "asc" },
  });

  const targetGroups = groupFiltersByType(campaign.filters);

  for (const other of otherActiveCampaigns) {
    const otherGroups = groupFiltersByType(other.filters);
    const sharedTypes = Object.keys(targetGroups).filter((type) => type in otherGroups);

    if (sharedTypes.length === 0) continue;

    const allTypesOverlap = sharedTypes.every((type) => {
      for (const value of targetGroups[type]) {
        if (otherGroups[type].has(value)) return true;
      }
      return false;
    });

    if (allTypesOverlap) {
      return { id: other.id, name: other.name };
    }
  }

  return null;
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

    res.json({ success: true, campaigns: campaigns.map(shapeCampaign) });
  } catch (err) {
    console.error("❌ Error loading campaigns:", err);
    res.status(500).json({ success: false, error: "Failed to load campaigns" });
  }
});

/**
 * ===========================================================
 * GET /api/campaigns/active-filters?shop=...&excludeCampaignId=...
 *
 * Filter values currently in use by active, non-expired campaigns,
 * grouped by filterType. Used by the create form to grey out audience
 * options that would loosely conflict — see Step 3 comment on the UI
 * side for why this only returns the flat sets rather than doing full
 * pairwise conflict checking (that's checkAudienceConflict's job).
 * ===========================================================
 */
router.get("/active-filters", async (req, res) => {
  try {
    const shopDomain = req.query.shop;
    if (!shopDomain) {
      return res.status(400).json({ success: false, error: "shop is required" });
    }

    const shop = await prisma.shop.findUnique({ where: { shopDomain } });
    if (!shop) {
      return res.status(404).json({ success: false, error: "Shop not found" });
    }

    const excludeCampaignId = req.query.excludeCampaignId ? Number(req.query.excludeCampaignId) : null;

    const now = new Date();
    const activeCampaigns = await prisma.campaign.findMany({
      where: {
        shopId: shop.id,
        active: true,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        ...(excludeCampaignId ? { id: { not: excludeCampaignId } } : {}),
      },
      include: { filters: true },
    });

    const grouped = groupFiltersByType(activeCampaigns.flatMap((c) => c.filters));

    res.json({
      success: true,
      role: [...(grouped.role || [])],
      country: [...(grouped.country || [])],
      resort: [...(grouped.resort || [])],
    });
  } catch (err) {
    console.error("❌ Error loading active filters:", err);
    res.status(500).json({ success: false, error: "Failed to load active filters" });
  }
});

/**
 * ===========================================================
 * PATCH /api/campaigns/:id/toggle-active?shop=...
 *
 * Flips the campaign's active state. Reactivating (false -> true) runs
 * the audience conflict check first and refuses with 409 if it finds one;
 * deactivating (true -> false) never conflicts, so it's unconditional.
 * ===========================================================
 */
router.patch("/:id/toggle-active", async (req, res) => {
  try {
    const shopDomain = req.query.shop;
    if (!shopDomain) {
      return res.status(400).json({ success: false, error: "shop is required" });
    }

    const shop = await prisma.shop.findUnique({ where: { shopDomain } });
    if (!shop) {
      return res.status(404).json({ success: false, error: "Shop not found" });
    }

    const campaignId = Number(req.params.id);
    if (isNaN(campaignId)) {
      return res.status(400).json({ success: false, error: "Invalid campaign id" });
    }

    const campaign = await prisma.campaign.findFirst({
      where: { id: campaignId, shopId: shop.id },
    });
    if (!campaign) {
      return res.status(404).json({ success: false, error: "Campaign not found" });
    }

    const activating = !campaign.active;

    if (activating) {
      const conflict = await checkAudienceConflict(campaignId, shop.id);
      if (conflict) {
        return res.status(409).json({
          error: "conflict",
          message: `This campaign conflicts with '${conflict.name}'. Deactivate that campaign first or adjust the audience filters before reactivating.`,
          conflictingCampaign: conflict,
        });
      }
    }

    const updated = await prisma.campaign.update({
      where: { id: campaignId },
      data: { active: activating },
      include: {
        filters: true,
        redemptions: { select: { status: true } },
      },
    });

    res.json({ success: true, campaign: shapeCampaign(updated) });
  } catch (err) {
    console.error("❌ Error toggling campaign active state:", err);
    res.status(500).json({ success: false, error: "Failed to update campaign" });
  }
});

export default router;
