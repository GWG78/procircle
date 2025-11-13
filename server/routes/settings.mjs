// server/routes/settings.mjs
import express from "express";
import prisma from "../prismaClient.js";
import verifyShopifyAuth from "../middleware/verifyShopifyAuth.js";
import { shopifyApi } from "@shopify/shopify-api";
import "@shopify/shopify-api/adapters/node";

const router = express.Router();

// Shopify client (same config as index.js)
const shopify = shopifyApi({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET,
  scopes: process.env.SHOPIFY_SCOPES.split(","),
  hostName: process.env.APP_URL.replace(/https?:\/\//, ""),
  apiVersion: process.env.SHOPIFY_API_VERSION || "2024-07",
  isEmbeddedApp: true,
});

// Default settings when none exist yet
function defaultSettings(shopId) {
  return {
    shopId,
    discountType: "percentage",
    discountValue: 20,
    categories: [],
    oneTimeUse: true,
    allowedCountries: [],
    allowedMemberTypes: [],
    expiryDays: 30,
    maxDiscounts: null,
  };
}

/**
 * GET /api/settings
 * Returns full ShopSettings record
 */
router.get("/", verifyShopifyAuth, async (req, res) => {
  try {
    const shopDomain = req.shop;

    const shop = await prisma.shop.findUnique({
      where: { shopDomain },
      include: { settings: true },
    });

    if (!shop) {
      return res.status(404).json({ error: "Shop not found" });
    }

    // If no settings exist yet, return defaults
    if (!shop.settings) {
      return res.json({
        success: true,
        shopDomain,
        settings: defaultSettings(shop.id),
      });
    }

    res.json({
      success: true,
      shopDomain,
      settings: shop.settings,
    });
  } catch (err) {
    console.error("❌ Error fetching settings:", err);
    res.status(500).json({ error: "Failed to load settings" });
  }
});

/**
 * POST /api/settings
 * Save / update settings
 */
router.post("/", verifyShopifyAuth, async (req, res) => {
  try {
    const shopDomain = req.shop;

    const shop = await prisma.shop.findUnique({
      where: { shopDomain },
    });

    if (!shop) {
      return res.status(404).json({ error: "Shop not found" });
    }

    const {
      discountType,
      discountValue,
      expiryDays,
      maxDiscounts,
      categories,
      oneTimeUse,
      allowedCountries,
      allowedMemberTypes,
    } = req.body;

    // Convert values
    const payload = {
      discountType,
      discountValue: Number(discountValue),
      expiryDays: expiryDays ? Number(expiryDays) : null,
      maxDiscounts: maxDiscounts ? Number(maxDiscounts) : null,
      categories: Array.isArray(categories) ? categories : [],
      oneTimeUse: !!oneTimeUse,
      allowedCountries: Array.isArray(allowedCountries)
        ? allowedCountries
        : [],
      allowedMemberTypes: Array.isArray(allowedMemberTypes)
        ? allowedMemberTypes
        : [],
    };

    const updated = await prisma.shopSettings.upsert({
      where: { shopId: shop.id },
      update: payload,
      create: { ...payload, shopId: shop.id },
    });

    res.json({
      success: true,
      settings: updated,
    });
  } catch (err) {
    console.error("❌ Error saving settings:", err);
    res.status(500).json({ error: "Failed to save settings" });
  }
});

/**
 * GET /api/settings/collections
 * Returns both Smart + Custom Shopify collections
 */
router.get("/collections", verifyShopifyAuth, async (req, res) => {
  try {
    const shopDomain = req.shop;

    const shop = await prisma.shop.findUnique({
      where: { shopDomain },
    });

    if (!shop || !shop.accessToken) {
      return res.status(404).json({ error: "Shop or access token not found" });
    }

    const client = new shopify.clients.Rest({
      session: {
        shop: shopDomain,
        accessToken: shop.accessToken,
      },
    });

    // Fetch collections
    const [customRes, smartRes] = await Promise.all([
      client.get({
        path: "custom_collections",
        query: { limit: 250 },
      }),
      client.get({
        path: "smart_collections",
        query: { limit: 250 },
      }),
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
    res.status(500).json({ error: "Failed to fetch collections" });
  }
});

export default router;