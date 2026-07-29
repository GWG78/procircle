// server/routes/brands.mjs
//
// Server-to-server endpoint for upserting Brand rows — bridges a Google
// Sheet brand signup (BrandID) to the Shopify shop domain that later
// installs the app. Called by trusted backend callers only (Apps Script's
// BrandSync.js), never by end users directly, so it uses the same
// shared-secret header pattern as routes/members.mjs rather than Shopify
// session auth.
import express from "express";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const router = express.Router();

// Shared-secret check — same GOOGLE_SHEET_SECRET env var and x-api-key
// header pattern as routes/members.mjs.
router.use((req, res, next) => {
  const token = req.headers["x-api-key"];
  if (!token || token !== process.env.GOOGLE_SHEET_SECRET) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }
  next();
});

/**
 * ===========================================================
 * POST /api/brands
 *
 * Upserts a Brand row keyed on shopDomain. Idempotent — calling this again
 * for the same shop (e.g. a sheet edit that re-fires onBrandSheetChange,
 * or BrandSync.js's retry-on-failure loop) updates brandId rather than
 * erroring or creating a duplicate.
 *
 * Deliberately does not touch wpBrandPostId — that's resolved and cached
 * lazily by routes/campaigns.mjs the first time it's needed, not set here.
 * ===========================================================
 */
router.post("/", async (req, res) => {
  try {
    const { brandId, shopDomain } = req.body || {};

    if (!brandId || typeof brandId !== "string" || !brandId.trim()) {
      return res.status(400).json({ success: false, error: "brandId is required" });
    }
    if (!shopDomain || typeof shopDomain !== "string" || !shopDomain.trim()) {
      return res.status(400).json({ success: false, error: "shopDomain is required" });
    }

    const cleanBrandId = brandId.trim();
    const cleanShopDomain = shopDomain.trim().toLowerCase();

    const brand = await prisma.brand.upsert({
      where: { shopDomain: cleanShopDomain },
      update: { brandId: cleanBrandId },
      create: { brandId: cleanBrandId, shopDomain: cleanShopDomain },
    });

    res.json({ success: true, brand });
  } catch (err) {
    // Most likely cause: brandId collides with a different shopDomain's
    // row (brandId is @unique too) — surfaced as a 409 rather than a bare
    // 500 so BrandSync.js's retry loop doesn't keep hammering on something
    // that will never succeed by retrying.
    if (err.code === "P2002") {
      console.error("❌ Brand upsert conflict:", err.meta);
      return res.status(409).json({ success: false, error: "brandId already linked to a different shop" });
    }

    console.error("❌ Error upserting brand:", err);
    res.status(500).json({ success: false, error: "Failed to upsert brand" });
  }
});

export default router;
