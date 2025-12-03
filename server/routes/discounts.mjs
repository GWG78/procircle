// server/routes/discounts.mjs
import express from "express";
import { PrismaClient } from "@prisma/client";
import { shopifyApi } from "@shopify/shopify-api";
import { generateDiscountCode } from "../utils/generateCode.js";

const prisma = new PrismaClient();
const router = express.Router();

/* ============================================================
   1. INTERNAL API KEY VALIDATION (Google Sheets → Node)
   ============================================================ */
router.use((req, res, next) => {
  const token = req.headers["x-api-key"];
  if (!token || token !== process.env.GOOGLE_SHEET_SECRET) {
    return res.status(401).json({
      success: false,
      error: "Unauthorized API access",
    });
  }
  next();
});

/* ============================================================
   2. Basic Shopify API
   ============================================================ */
const shopify = shopifyApi({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET,
  scopes: process.env.SHOPIFY_SCOPES.split(","),
  hostName: process.env.APP_URL.replace(/https?:\/\//, ""),
  apiVersion: process.env.SHOPIFY_API_VERSION || "2024-07",
  isEmbeddedApp: true,
});

/* ============================================================
   3. Payload Validation
   ============================================================ */
function validateDiscountPayload(body) {
  const errors = [];

  if (!body.shopDomain) errors.push("shopDomain is required");
  if (!body.userId) errors.push("userId is required");
  if (!body.email) errors.push("email is required");

  // Force type into one of the allowed values
  const type = body.type === "fixed" ? "fixed" : "percentage";

  // Clean amount
  let amount = Number(body.amount);
  if (isNaN(amount) || amount <= 0) {
    errors.push("amount must be a positive number");
  }
  if (type === "percentage" && amount > 100) {
    amount = 100; // clamp
  }

  // expiryDays: 1–365 or null
  let expiryDays =
    body.expiryDays === null || body.expiryDays === undefined
      ? null
      : Math.max(1, Math.min(365, Number(body.expiryDays) || 1));

  // maxDiscounts: positive integer or null
  let maxDiscounts =
    body.maxDiscounts === null || body.maxDiscounts === undefined
      ? null
      : Math.max(1, Number(body.maxDiscounts) || 1);

  return {
    errors,
    clean: {
      shopDomain: body.shopDomain,
      userId: body.userId,
      email: body.email,
      name: body.name || "",
      type,
      amount,
      expiryDays,
      maxDiscounts,
      oneTimeUse: !!body.oneTimeUse,
      categories: Array.isArray(body.categories) ? body.categories : [],
      allowedCountries: Array.isArray(body.allowedCountries)
        ? body.allowedCountries
        : [],
      allowedMemberTypes: Array.isArray(body.allowedMemberTypes)
        ? body.allowedMemberTypes
        : [],
    },
  };
}

/* ============================================================
   4. MAIN ENDPOINT — POST /api/discounts/create
   ============================================================ */
router.post("/create", async (req, res) => {
  try {
    /* -------- Step 1: Validate payload -------- */
    const { errors, clean } = validateDiscountPayload(req.body || {});
    if (errors.length) {
      return res.status(400).json({ success: false, error: errors.join(", ") });
    }

    /* -------- Step 2: Load shop + settings -------- */
    const shop = await prisma.shop.findUnique({
      where: { shopDomain: clean.shopDomain },
      include: { settings: true },
    });

    if (!shop) {
      return res.status(404).json({ success: false, error: "Shop not found" });
    }

    const s = shop.settings || {};

    /* -----------------------------------------------------
       Step 3: Eligibility checks based on ADMIN SETTINGS
       ----------------------------------------------------- */

    // Allowed country check
    if (s.allowedCountries?.length) {
      if (!clean.allowedCountries?.some(c => s.allowedCountries.includes(c))) {
        return res.status(403).json({
          success: false,
          error: "Country not allowed",
        });
      }
    }

    // Allowed member types
    if (s.allowedMemberTypes?.length) {
      if (!clean.allowedMemberTypes?.some(t => s.allowedMemberTypes.includes(t))) {
        return res.status(403).json({
          success: false,
          error: "Member type not allowed",
        });
      }
    }

    // Collections
    let applicableCollections = [];
    if (s.categories?.length) {
      applicableCollections = [...s.categories];
    }

    /* -----------------------------------------------------
       Step 4: Prevent duplicates / enforce maxDiscounts
       ----------------------------------------------------- */

    const existing = await prisma.discount.findFirst({
      where: {
        userId: clean.userId,
        shopId: shop.id,
      },
    });

    if (existing) {
      return res.status(409).json({
        success: false,
        error: "User already has a discount",
      });
    }

    if (s.maxDiscounts && s.maxDiscounts > 0) {
      const issued = await prisma.discount.count({
        where: { shopId: shop.id },
      });

      if (issued >= s.maxDiscounts) {
        return res.status(429).json({
          success: false,
          error: "Max number of discounts reached",
        });
      }
    }

    /* -------- Step 5: Prepare Shopify API client -------- */
    const client = new shopify.clients.Rest({
      session: {
        shop: shop.shopDomain,
        accessToken: shop.accessToken,
      },
    });

    /* -------- Step 6: Generate code -------- */
    const code = generateDiscountCode(clean.name);
    const startsAt = new Date().toISOString();

    const expiry =
      s.expiryDays || clean.expiryDays
        ? new Date(Date.now() + (s.expiryDays || clean.expiryDays) * 86400000).toISOString()
        : null;

    /* -----------------------------------------------------
       Step 7: Create DISCOUNT via Shopify 2024 API
       (Automatic + Code)
       ----------------------------------------------------- */

    const discountPayload = {
      discount: {
        title: `ProCircle-${code}`,
        code,
        combines_with: {
          product_discounts: true,
          order_discounts: false,
          shipping_discounts: false,
        },
        starts_at: startsAt,
        ends_at: expiry,
        usage_limit: clean.oneTimeUse ? 1 : null,
        customer_selection: { all: true },
        // Value section
        value: clean.type === "percentage"
          ? { percentage: { value: clean.amount } }
          : { fixed_amount: { amount: clean.amount, currency_code: "GBP" } },

        // Collections restriction
        entitled_collection_ids: applicableCollections.length ? applicableCollections : [],

        // Applies to all products if no collections defined
        applies_to_each_item: !applicableCollections.length,
      }
    };

    const shopifyRes = await client.post({
      path: "discounts",
      data: discountPayload,
      type: "application/json",
    });

    /* -------- Step 8: Save locally -------- */
    const saved = await prisma.discount.create({
      data: {
        shopId: shop.id,
        userId: clean.userId,
        code,
        type: clean.type,
        amount: clean.amount,
        expiresAt: expiry ? new Date(expiry) : null,
      },
    });

    return res.json({
      success: true,
      discount: saved,
    });

  } catch (err) {
    console.error("❌ Discount creation error:", err);

    return res.status(500).json({
      success: false,
      error: "Shopify discount creation failed",
      details: err.message,
    });
  }
});

export default router;