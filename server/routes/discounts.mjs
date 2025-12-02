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
    /* -------------- Step 1: Validate Payload -------------- */
    const { errors, clean } = validateDiscountPayload(req.body || {});
    if (errors.length) {
      return res.status(400).json({
        success: false,
        error: "Validation failed",
        details: errors,
      });
    }

    /* -------------- Step 2: Load Shop + Settings ----------- */
    const shop = await prisma.shop.findUnique({
      where: { shopDomain: clean.shopDomain },
      include: { settings: true },
    });

    if (!shop) {
      return res.status(404).json({
        success: false,
        error: "Shop not found",
      });
    }

    const settings = shop.settings || {};

    /* ======================================================
       Step 3 — SERVER-SIDE PROTECTION:
       - Prevent duplicate code for same user + shop  
       - Enforce maxDiscounts
       ====================================================== */

    // Prevent user having >1 code per shop
    const existing = await prisma.discount.findFirst({
      where: {
        shopId: shop.id,
        userId: clean.userId,
      },
    });

    if (existing) {
      return res.status(409).json({
        success: false,
        error: "User already has a discount code for this shop",
      });
    }

    // MaxDiscounts enforcement
    if (settings.maxDiscounts && settings.maxDiscounts > 0) {
      const totalIssued = await prisma.discount.count({
        where: { shopId: shop.id },
      });

      if (totalIssued >= settings.maxDiscounts) {
        return res.status(429).json({
          success: false,
          error: "Maximum number of discount codes has been reached",
        });
      }
    }

    /* -------------- Step 4: Expiry Calculation ------------ */
    const expiryDays =
      clean.expiryDays ??
      settings.expiryDays ??
      30; // fallback if needed

    const expiryDate = new Date(
      Date.now() + expiryDays * 24 * 60 * 60 * 1000
    );

    /* -------------- Step 5: Create in Shopify ------------- */

    const code = generateDiscountCode(clean.name);

    const client = new shopify.clients.Rest({
      session: {
        shop: shop.shopDomain,
        accessToken: shop.accessToken,
      },
    });

    // Create price rule
    const priceRuleRes = await client.post({
      path: "price_rules",
      data: {
        price_rule: {
          title: `ProCircle-${code}`,
          target_type: "line_item",
          target_selection: "all",
          allocation_method: "across",
          value_type: clean.type === "percentage" ? "percentage" : "fixed_amount",
          value: clean.type === "percentage"
            ? `-${clean.amount}`
            : `-${clean.amount}`,
          once_per_customer: clean.oneTimeUse,
          usage_limit: clean.oneTimeUse ? 1 : null,
          customer_selection: "all",
          starts_at: new Date().toISOString(),
          ends_at: expiryDate.toISOString(),
        },
      },
      type: "application/json",
    });

    const priceRuleId = priceRuleRes.body.price_rule.id;

    // Create discount code in that rule
    const discountRes = await client.post({
      path: `price_rules/${priceRuleId}/discount_codes`,
      data: { discount_code: { code } },
      type: "application/json",
    });

    /* -------------- Step 6: Save Locally ------------------ */
    const discount = await prisma.discount.create({
      data: {
        shopId: shop.id,
        userId: clean.userId,
        code,
        amount: clean.amount,
        type: clean.type,
        expiresAt: expiryDate,
      },
    });

    /* -------------- Step 7: Final Response ---------------- */
    return res.json({
      success: true,
      discount,
    });

  } catch (error) {
    console.error("❌ Discount creation failed:", error);
    return res.status(500).json({
      success: false,
      error: "Failed to create discount",
      details: error.message,
    });
  }
});

export default router;