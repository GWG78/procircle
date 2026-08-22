// server/routes/settings.mjs
import express from "express";
import multer from "multer";
import prisma from "../prismaClient.js";
import verifyShopifyAuth from "../middleware/verifyShopifyAuth.js";
import { shopifyApi } from "@shopify/shopify-api";
import { shopify } from "../shopify.js";
import { uploadWpMedia, setWpTermLogo } from "../services/wordpress.js";
import { isBrandProfileComplete } from "../services/brandProfileService.js";


const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
});

/* Shopify API (matches index.js)
const shopify = shopifyApi({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET,
  scopes: process.env.SHOPIFY_SCOPES.split(","),
  hostName: process.env.APP_URL.replace(/https?:\/\//, ""),
  apiVersion: process.env.SHOPIFY_API_VERSION,
  isEmbeddedApp: true,
});*/

// Default settings for new shops (no ShopSettings row yet)
function getDefaultSettings(shopId) {
  return {
    shopId,
    discountType: "percentage",
    discountValue: 20,
    expiryDays: 30,
    maxDiscounts: null,
    oneTimeUse: true,
    allowedCountries: [],
    allowedMemberTypes: [],
    description: null,
    contactName: null,
    contactEmail: null,
  };
}

/**
 * -------------------------------------------------------------
 * ✅ VALIDATION HELPERS (added by patch)
 * -------------------------------------------------------------
 */
const ALLOWED_COUNTRIES = ["UK", "CH", "FR", "IT", "DE", "AT"];
const ALLOWED_MEMBER_TYPES = [
  "instructor",
  "club_member",
  "competitor",
  "mountain_guide",
];

// Deliberately simple — good enough to catch typos/garbage input without
// rejecting real addresses on some RFC 5322 edge case. Matches the "type"
// of check type="email" already does client-side; this is just the
// server-side backstop for direct API calls.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const BRAND_DESCRIPTION_MAX_LENGTH = 300;

/**
 * ===========================================================
 * GET /api/settings
 * Returns existing settings or default structure
 * ===========================================================
 */
router.get("/", verifyShopifyAuth, async (req, res) => {
  try {
    // Authoritative shop comes from the verified session token, not
    // req.query.shop — that's caller-supplied and shouldn't be trusted.
    const shop = await prisma.shop.findUnique({
      where: { id: req.shopifyShop.id },
      include: { settings: true },
    });
    const shopDomain = req.shopifyShop.shopDomain;

    // Return defaults if settings do not yet exist
    if (!shop.settings) {
      const settings = getDefaultSettings(shop.id);
      return res.json({
        success: true,
        shopDomain,
        settings,
        profileComplete: isBrandProfileComplete(settings),
      });
    }

    res.json({
      success: true,
      shopDomain,
      settings: shop.settings,
      profileComplete: isBrandProfileComplete(shop.settings),
    });
  } catch (err) {
    console.error("❌ Error loading settings:", err);
    res.status(500).json({ success: false, error: "Failed to load settings" });
  }
});

/**
 * ===========================================================
 * POST /api/settings
 * Saves settings to DB
 * ===========================================================
 */
router.post("/", verifyShopifyAuth, async (req, res) => {
  try {
    const shop = req.shopifyShop;

    const { description, contactName, contactEmail } = req.body || {};

    // TODO: migrate to Campaign/Redemption model — discountType, discountValue,
    // expiryDays, maxDiscounts, oneTimeUse, allowedCountries, and allowedMemberTypes
    // were removed from ShopSettings (now campaign-level concerns). The block below
    // previously wrote those fields via prisma.shopSettings.upsert(), which will now
    // throw a PrismaClientValidationError (unknown args) — left commented out
    // pending the Campaign-based settings rework.
    // const baseType = discountType === "fixed" ? "fixed" : "percentage";
    // const clean = {
    //   discountType: baseType,
    //   discountValue: (() => { ... })(),
    //   expiryDays: (() => { ... })(),
    //   maxDiscounts: (() => { ... })(),
    //   oneTimeUse: !!oneTimeUse,
    //   allowedCountries: sanitizeStringArray(allowedCountries).filter(c => ALLOWED_COUNTRIES.includes(c)),
    //   allowedMemberTypes: sanitizeStringArray(allowedMemberTypes).filter(m => ALLOWED_MEMBER_TYPES.includes(m)),
    // };

    const cleanDescription = typeof description === "string" ? description.trim() : "";
    if (cleanDescription.length > BRAND_DESCRIPTION_MAX_LENGTH) {
      return res.status(400).json({
        success: false,
        error: `description must be ${BRAND_DESCRIPTION_MAX_LENGTH} characters or fewer`,
      });
    }

    const cleanContactEmail = typeof contactEmail === "string" ? contactEmail.trim() : "";
    // Client enforces the same format via <input type="email">, but that's
    // UI-only — validate here too since this endpoint can be called
    // directly (same reasoning as campaigns.mjs's validForDays check).
    if (cleanContactEmail && !EMAIL_PATTERN.test(cleanContactEmail)) {
      return res.status(400).json({ success: false, error: "contactEmail must be a valid email address" });
    }

    const clean = {
      description: cleanDescription || null,
      contactName: typeof contactName === "string" && contactName.trim() ? contactName.trim() : null,
      contactEmail: cleanContactEmail || null,
    };

    const updated = await prisma.shopSettings.upsert({
      where: { shopId: shop.id },
      update: clean,
      create: { ...clean, shopId: shop.id },
    });

    res.json({ success: true, settings: updated, profileComplete: isBrandProfileComplete(updated) });
  } catch (err) {
    console.error("❌ Error saving settings:", err);
    res.status(500).json({ success: false, error: "Failed to save settings" });
  }
});

/**
 * ===========================================================
 * GET /api/settings/collections
 * Fetches Shopify smart + custom collections
 * ===========================================================
 */
router.get("/collections", verifyShopifyAuth, async (req, res) => {
  try {
    const shop = req.shopifyShop;

    if (!shop.accessToken) {
      return res.status(404).json({ success: false, error: "Missing shop or access token" });
    }

    const client = new shopify.clients.Rest({
      session: {
        shop: shop.shopDomain,
        accessToken: shop.accessToken,
      },
    });

    const [customRes, smartRes] = await Promise.all([
      client.get({ path: "custom_collections", query: { limit: 250 } }),
      client.get({ path: "smart_collections", query: { limit: 250 } }),
    ]);

    const custom = customRes.body?.custom_collections || [];
    const smart = smartRes.body?.smart_collections || [];

    const collections = [...custom, ...smart].map((c) => ({
      id: c.id,
      handle: c.handle,
      title: c.title,
    }));

    res.json({
      success: true,
      collections,
    });
  } catch (err) {
    console.error("❌ Error fetching collections:", err);
    res.status(500).json({ success: false, error: "Failed to fetch collections" });
  }
});

/**
 * ===========================================================
 * POST /api/settings/logo?shop=...
 *
 * Accepts a single image upload (multipart/form-data, field name
 * "logo"). Always uploads to the WP media library and caches the
 * attachment ID on Shop — if a campaign_brand term already exists for
 * this shop, also pushes it onto the term immediately. If not, it
 * stays cached until the shop's first campaign creates the term (see
 * routes/campaigns.mjs).
 * ===========================================================
 */
router.post("/logo", verifyShopifyAuth, upload.single("logo"), async (req, res) => {
  try {
    const shop = req.shopifyShop;

    if (!req.file) {
      return res.status(400).json({ success: false, error: "No file uploaded" });
    }

    const attachmentId = await uploadWpMedia(req.file.buffer, req.file.originalname, req.file.mimetype);

    if (!attachmentId) {
      return res.status(502).json({ success: false, error: "Failed to upload logo to WordPress" });
    }

    await prisma.shop.update({ where: { id: shop.id }, data: { logoWpAttachmentId: attachmentId } });

    if (shop.wpBrandTermId) {
      await setWpTermLogo(shop.wpBrandTermId, attachmentId);
    }

    res.json({ success: true, attachmentId });
  } catch (err) {
    console.error("❌ Error uploading logo:", err);
    res.status(500).json({ success: false, error: "Failed to upload logo" });
  }
});

export default router;