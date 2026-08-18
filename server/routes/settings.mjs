// server/routes/settings.mjs
import express from "express";
import multer from "multer";
import prisma from "../prismaClient.js";
import verifyShopifyAuth from "../middleware/verifyShopifyAuth.js";
import { shopifyApi } from "@shopify/shopify-api";
import { shopify } from "../shopify.js";
import { uploadWpMedia, setWpTermLogo } from "../services/wordpress.js";


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

// Default settings for new shops
function getDefaultSettings(shopId) {
  return {
    shopId,
    discountType: "percentage",
    discountValue: 20,
    expiryDays: 30,
    maxDiscounts: null,
    oneTimeUse: true,
    categories: [],
    allowedCountries: [],
    allowedMemberTypes: [],
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

function sanitizeStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map(v => (typeof v === "string" ? v.trim() : ""))
    .filter(Boolean);
}

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
      return res.json({
        success: true,
        shopDomain,
        settings: getDefaultSettings(shop.id),
      });
    }

    res.json({
      success: true,
      shopDomain,
      settings: shop.settings,
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

    const { categories } = req.body;

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
    //   categories: sanitizeStringArray(categories),
    //   allowedCountries: sanitizeStringArray(allowedCountries).filter(c => ALLOWED_COUNTRIES.includes(c)),
    //   allowedMemberTypes: sanitizeStringArray(allowedMemberTypes).filter(m => ALLOWED_MEMBER_TYPES.includes(m)),
    // };

    const clean = {
      categories: sanitizeStringArray(categories),
    };

    const updated = await prisma.shopSettings.upsert({
      where: { shopId: shop.id },
      update: clean,
      create: { ...clean, shopId: shop.id },
    });

    res.json({ success: true, settings: updated });
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