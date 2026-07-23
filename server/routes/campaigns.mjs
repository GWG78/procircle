// server/routes/campaigns.mjs
import express from "express";
import { PrismaClient } from "@prisma/client";
import { createCampaignDiscount, setCampaignDiscountActive } from "../services/discountLinkService.js";
import { getOrCreateSentinelCustomer } from "../services/shopifyCustomerService.js";
import { countMatchingMembers } from "../services/eligibilityService.js";
import { endCampaignAndNotify } from "../services/campaignLifecycleService.js";
import verifyShopifyAuth from "../middleware/verifyShopifyAuth.js";

const prisma = new PrismaClient();
const router = express.Router();

// discountCodeBasicCreate rejects an empty customers.add[] — this sentinel
// keeps a campaign's discount customerSelection list non-empty from the
// moment it's created, before any real member has redeemed. It's never
// removed by the expiry cron (see shopifyCustomerService.getOrCreateSentinelCustomer).
const SENTINEL_CUSTOMER = {
  email: "hi@procircle.io",
  firstName: "ProCircle",
  lastName: "Admin",
};

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

/**
 * Derives the 5-state display status from the stored `status` field plus
 * existing fields — only "paused" and "ended" are ever stored directly.
 * "draft" and "cap_reached" are passive/automatic states layered on top of
 * "active", the same way Shopify's own discount startsAt already gates
 * usability without a separate stored flag:
 *   - status !== "active"          -> pass through ("paused" / "ended")
 *   - active + startsAt in future  -> "draft" (not yet live to members)
 *   - active + cap reached         -> "cap_reached"
 *   - otherwise                    -> "active"
 */
function deriveStatus(campaign, confirmedCount) {
  if (campaign.status !== "active") return campaign.status;

  if (campaign.maxRedemptions != null && confirmedCount >= campaign.maxRedemptions) {
    return "cap_reached";
  }

  if (campaign.startsAt && new Date(campaign.startsAt) > new Date()) {
    return "draft";
  }

  return "active";
}

/**
 * Shapes a Campaign row (with `filters` and `redemptions` included) into
 * the response shape the UI expects: derived `status`, total redemption
 * `_count`, `confirmedRedemptions`, and sales figures. Shared by every
 * route that returns campaign objects so the shape stays consistent.
 *
 * `redemptions` must include at least { status, shopifyOrderId, orderAmount }
 * for the sales figures to be accurate — callers that only need status
 * (e.g. nothing currently) can omit the rest, but every route below selects
 * all three since sales are now part of the standard campaign shape.
 */
function shapeCampaign(campaign) {
  const { redemptions = [], ...rest } = campaign;
  const confirmedRedemptions = redemptions.filter((r) => r.status === "confirmed");
  const sales = confirmedRedemptions.filter((r) => r.shopifyOrderId != null);

  return {
    ...rest,
    status: deriveStatus(rest, confirmedRedemptions.length),
    _count: { redemptions: redemptions.length },
    confirmedRedemptions: confirmedRedemptions.length,
    salesCount: sales.length,
    salesRevenue: sales.reduce((sum, r) => sum + (r.orderAmount || 0), 0),
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
 * with any other currently active campaign on `shopId`.
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

  const otherActiveCampaigns = await prisma.campaign.findMany({
    where: {
      shopId,
      id: { not: campaignId },
      status: "active",
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
router.post("/create", verifyShopifyAuth, async (req, res) => {
  let createdCampaignId = null;

  try {
    // Authoritative shop comes from the verified session token, not
    // req.query.shop — that's caller-supplied and shouldn't be trusted.
    const shop = req.shopifyShop;

    const {
      name,
      discountType,
      discountValue,
      startsAt,
      validForDays,
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

    // Client enforces the same 30-day floor, but that's UI-only — validate
    // here too since this endpoint can be called directly.
    const numericValidForDays = validForDays != null && validForDays !== "" ? Number(validForDays) : 30;
    if (isNaN(numericValidForDays) || numericValidForDays < 30) {
      return res.status(400).json({ success: false, error: "validForDays must be at least 30" });
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
          validForDays: numericValidForDays,
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

    // 2. Get/create the sentinel customer, then create the backing Shopify
    // discount seeded with it. If either step fails, the campaign is
    // useless (no link to share) — roll it back rather than leaving an
    // orphaned campaign with no discount.
    let discountResult;
    try {
      const sentinelCustomerId = await getOrCreateSentinelCustomer(shop, SENTINEL_CUSTOMER);
      discountResult = await createCampaignDiscount(shop, campaign, sentinelCustomerId);
    } catch (err) {
      console.error(`❌ Discount setup failed for campaign ${campaign.id}:`, err);

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
        redemptions: { select: { status: true, shopifyOrderId: true, orderAmount: true } },
      },
    });

    // audienceSize is a live count against the Member table, not something
    // stored on Campaign — computed per campaign here rather than inside
    // shapeCampaign so shapeCampaign can stay a plain sync function.
    const shaped = await Promise.all(
      campaigns.map(async (campaign) => ({
        ...shapeCampaign(campaign),
        audienceSize: await countMatchingMembers(campaign.filters),
      }))
    );

    res.json({ success: true, campaigns: shaped });
  } catch (err) {
    console.error("❌ Error loading campaigns:", err);
    res.status(500).json({ success: false, error: "Failed to load campaigns" });
  }
});

/**
 * ===========================================================
 * GET /api/campaigns/active-filters?shop=...&excludeCampaignId=...
 *
 * Filter values currently in use by active campaigns, grouped by
 * filterType. Used by the create form to grey out audience
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

    const activeCampaigns = await prisma.campaign.findMany({
      where: {
        shopId: shop.id,
        status: "active",
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
 * Loads a campaign scoped to the verified shop, or null. Shared by the
 * three lifecycle actions below.
 */
async function findOwnedCampaign(campaignId, shopId) {
  return prisma.campaign.findFirst({ where: { id: campaignId, shopId } });
}

function includeForShapedCampaign() {
  return {
    filters: true,
    redemptions: { select: { status: true, shopifyOrderId: true, orderAmount: true } },
  };
}

/**
 * ===========================================================
 * POST /api/campaigns/:id/pause?shop=...
 *
 * DB-only: does NOT touch the Shopify discount. Members who already
 * claimed a code (confirmed Redemption) keep a working code and can still
 * redeem — pausing only stops the campaign from being offered to new
 * members via getOffersForMember/checkEligibility. Fully reversible via
 * /resume with no Shopify-side cleanup needed, since nothing was changed
 * on Shopify. No confirmation modal on the frontend — simple, safe toggle.
 * ===========================================================
 */
router.post("/:id/pause", verifyShopifyAuth, async (req, res) => {
  try {
    const shop = req.shopifyShop;
    const campaignId = Number(req.params.id);
    if (isNaN(campaignId)) {
      return res.status(400).json({ success: false, error: "Invalid campaign id" });
    }

    const campaign = await findOwnedCampaign(campaignId, shop.id);
    if (!campaign) {
      return res.status(404).json({ success: false, error: "Campaign not found" });
    }
    if (campaign.status !== "active") {
      return res.status(400).json({ success: false, error: `Cannot pause a campaign with status "${campaign.status}"` });
    }

    const updated = await prisma.campaign.update({
      where: { id: campaignId },
      data: { status: "paused", pausedAt: new Date() },
      include: includeForShapedCampaign(),
    });

    res.json({ success: true, campaign: { ...shapeCampaign(updated), audienceSize: await countMatchingMembers(updated.filters) } });
  } catch (err) {
    console.error("❌ Error pausing campaign:", err);
    res.status(500).json({ success: false, error: "Failed to pause campaign" });
  }
});

/**
 * ===========================================================
 * POST /api/campaigns/:id/resume?shop=...
 *
 * Reverses /pause. Runs the same audience conflict check as the old
 * reactivation path (refuses with 409 if another active campaign now
 * overlaps). DB-only — pause never touched Shopify, so resume has
 * nothing to undo there either.
 * ===========================================================
 */
router.post("/:id/resume", verifyShopifyAuth, async (req, res) => {
  try {
    const shop = req.shopifyShop;
    const campaignId = Number(req.params.id);
    if (isNaN(campaignId)) {
      return res.status(400).json({ success: false, error: "Invalid campaign id" });
    }

    const campaign = await findOwnedCampaign(campaignId, shop.id);
    if (!campaign) {
      return res.status(404).json({ success: false, error: "Campaign not found" });
    }
    if (campaign.status !== "paused") {
      return res.status(400).json({ success: false, error: `Cannot resume a campaign with status "${campaign.status}"` });
    }

    const conflict = await checkAudienceConflict(campaignId, shop.id);
    if (conflict) {
      return res.status(409).json({
        error: "conflict",
        message: `This campaign conflicts with '${conflict.name}'. Pause or end that campaign first, or adjust the audience filters before resuming.`,
        conflictingCampaign: conflict,
      });
    }

    const updated = await prisma.campaign.update({
      where: { id: campaignId },
      data: { status: "active", pausedAt: null },
      include: includeForShapedCampaign(),
    });

    res.json({ success: true, campaign: { ...shapeCampaign(updated), audienceSize: await countMatchingMembers(updated.filters) } });
  } catch (err) {
    console.error("❌ Error resuming campaign:", err);
    res.status(500).json({ success: false, error: "Failed to resume campaign" });
  }
});

/**
 * ===========================================================
 * GET /api/campaigns/:id/claimed-count?shop=...
 *
 * Count of members who claimed a code (confirmed Redemption) but haven't
 * used it at checkout yet (shopifyOrderId still null). Powers the End
 * Campaign confirmation modal only — deliberately not part of the main
 * campaign list/dashboard response.
 * ===========================================================
 */
router.get("/:id/claimed-count", verifyShopifyAuth, async (req, res) => {
  try {
    const shop = req.shopifyShop;
    const campaignId = Number(req.params.id);
    if (isNaN(campaignId)) {
      return res.status(400).json({ success: false, error: "Invalid campaign id" });
    }

    const campaign = await findOwnedCampaign(campaignId, shop.id);
    if (!campaign) {
      return res.status(404).json({ success: false, error: "Campaign not found" });
    }

    const count = await prisma.redemption.count({
      where: { campaignId, status: "confirmed", shopifyOrderId: null },
    });

    res.json({ success: true, count });
  } catch (err) {
    console.error("❌ Error counting claimed redemptions:", err);
    res.status(500).json({ success: false, error: "Failed to count claimed redemptions" });
  }
});

/**
 * ===========================================================
 * POST /api/campaigns/:id/end?shop=...
 *
 * Terminal, not resumable. Deactivates the Shopify discount for everyone,
 * including members who claimed but haven't redeemed — that's the whole
 * point (distinct from /pause, which protects them). Order matters: the
 * claimed-member list is loaded before anything is mutated, the Shopify
 * call happens before the DB write (same never-diverge pattern as the old
 * toggle-active), and the notification emails are best-effort *after* the
 * DB write succeeds — an email failure shouldn't undo an already-completed
 * end action.
 * ===========================================================
 */
router.post("/:id/end", verifyShopifyAuth, async (req, res) => {
  try {
    const shop = req.shopifyShop;
    const campaignId = Number(req.params.id);
    if (isNaN(campaignId)) {
      return res.status(400).json({ success: false, error: "Invalid campaign id" });
    }

    const campaign = await findOwnedCampaign(campaignId, shop.id);
    if (!campaign) {
      return res.status(404).json({ success: false, error: "Campaign not found" });
    }
    if (campaign.status === "ended") {
      return res.status(400).json({ success: false, error: "Campaign has already ended" });
    }

    if (campaign.shopifyDiscountId) {
      try {
        // If the discount was already deleted outside the app (e.g. via
        // Shopify's own Discounts page), this resolves normally instead of
        // throwing — see setCampaignDiscountActive's DISCOUNT_ALREADY_GONE
        // handling — so a merchant can still End a campaign whose discount
        // is already gone rather than getting stuck on a 500.
        await setCampaignDiscountActive(shop, campaign.shopifyDiscountId, false, { campaignId: campaign.id });
      } catch (err) {
        console.error(`❌ Failed to deactivate Shopify discount for campaign ${campaign.id}:`, err);
        return res.status(500).json({
          success: false,
          error: "Failed to deactivate the Shopify discount. Campaign was not ended.",
          details: err.message,
        });
      }
    } else {
      console.warn(`⚠️ Campaign ${campaign.id} (${campaign.slug}) has no shopifyDiscountId — skipping Shopify deactivate call.`);
    }

    // Race-safe against the discounts/delete webhook landing at the same
    // moment — see campaignLifecycleService for how that's handled.
    await endCampaignAndNotify(campaignId, { shopDomain: shop.shopDomain });

    const updated = await prisma.campaign.findUnique({
      where: { id: campaignId },
      include: includeForShapedCampaign(),
    });

    res.json({ success: true, campaign: { ...shapeCampaign(updated), audienceSize: await countMatchingMembers(updated.filters) } });
  } catch (err) {
    console.error("❌ Error ending campaign:", err);
    res.status(500).json({ success: false, error: "Failed to end campaign" });
  }
});

/**
 * ===========================================================
 * POST /api/campaigns/preview-audience-size?shop=...
 *
 * Body: { filters: [{ filterType, value }, ...] }. Returns a live count of
 * verified members matching the in-progress filter selection, using the
 * same AND-across-types/OR-within-type semantics as saved campaigns. An
 * empty filters array (nothing selected in either group) matches
 * everyone, same as an unfiltered campaign.
 * ===========================================================
 */
router.post("/preview-audience-size", verifyShopifyAuth, async (req, res) => {
  try {
    const filters = Array.isArray(req.body?.filters)
      ? req.body.filters.filter((f) => f && typeof f.filterType === "string" && typeof f.value === "string")
      : [];

    const count = await countMatchingMembers(filters);
    res.json({ success: true, count });
  } catch (err) {
    console.error("❌ Error previewing audience size:", err);
    res.status(500).json({ success: false, error: "Failed to preview audience size" });
  }
});

export default router;
