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
   2. Setup Shopify API Client
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

  const type = "percentage"; // force percentage-only

  let amount = Number(body.amount);
  if (isNaN(amount) || amount <= 0) {
    errors.push("amount must be a positive number");
  }
  if (amount > 100) amount = 100;

  const expiryDays =
    body.expiryDays !== undefined && body.expiryDays !== null
      ? Math.max(1, Math.min(365, Number(body.expiryDays)))
      : null;

  const maxDiscounts =
    body.maxDiscounts !== undefined && body.maxDiscounts !== null
      ? Math.max(1, Number(body.maxDiscounts))
      : null;

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
   Helper: Create Shopify Discount via GraphQL
   ============================================================ */
async function createShopifyDiscount(client, code, clean, expiryIso) {
  const mutation = `
    mutation discountCodeBasicCreate($discount: DiscountCodeBasicInput!) {
      discountCodeBasicCreate(basicCodeDiscount: $discount) {
        codeDiscountNode {
          id
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const variables = {
    discount: {
      title: `ProCircle-${code}`,
      code,
      startsAt: new Date().toISOString(),
      endsAt: expiryIso,
      usageLimit: clean.oneTimeUse ? 1 : null,
      appliesOncePerCustomer: clean.oneTimeUse,
      customerSelection: { all: true },

      customerGets: {
        value: {
          percentageValue: clean.amount,
        },
        items: clean.categories.length
          ? {
              collections: clean.categories.map((id) => ({ id })),
            }
          : {
              all: true,
            },
      },
    },
  };

  return client.query({
    data: {
      query: mutation,
      variables,
    },
  });
}

/* ============================================================
   4. MAIN ENDPOINT — POST /api/discounts/create
   ============================================================ */
router.post("/create", async (req, res) => {
  try {
    /* ----------------- Step 1: Validate ----------------- */
    const { errors, clean } = validateDiscountPayload(req.body || {});
    if (errors.length) {
      return res.status(400).json({
        success: false,
        error: "Validation failed",
        details: errors,
      });
    }

    /* ----------------- Step 2: Load shop + settings ----------------- */
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

    const s = shop.settings || {};

    /* ----------------- Step 3: Eligibility Gates ----------------- */

    // Country check
    if (s.allowedCountries?.length > 0) {
      if (!clean.allowedCountries?.some((c) => s.allowedCountries.includes(c))) {
        return res.status(403).json({
          success: false,
          error: "Country not allowed",
        });
      }
    }

    // Member type check
    if (s.allowedMemberTypes?.length > 0) {
      if (
        !clean.allowedMemberTypes?.some((t) =>
          s.allowedMemberTypes.includes(t)
        )
      ) {
        return res.status(403).json({
          success: false,
          error: "Member type not allowed",
        });
      }
    }

    /* ----------------- Step 4: Prevent duplicate codes ----------------- */
    const existing = await prisma.discount.findFirst({
      where: { userId: clean.userId, shopId: shop.id },
    });

    if (existing) {
      return res.status(409).json({
        success: false,
        error: "User already has a discount",
      });
    }

    /* ----------------- Step 5: MaxDiscounts enforcement ----------------- */
    if (s.maxDiscounts && s.maxDiscounts > 0) {
      const issued = await prisma.discount.count({
        where: { shopId: shop.id },
      });

      if (issued >= s.maxDiscounts) {
        return res.status(429).json({
          success: false,
          error: "Maximum number of discount codes reached",
        });
      }
    }

    /* ----------------- Step 6: Prepare Shopify client ----------------- */
    const client = new shopify.clients.Graphql({
      session: {
        shop: shop.shopDomain,
        accessToken: shop.accessToken,
      },
    });

    /* ----------------- Step 7: Generate discount code ----------------- */
    const code = generateDiscountCode(clean.name);

    const expiryDays = clean.expiryDays ?? s.expiryDays ?? 30;
    const expiryIso = new Date(Date.now() + expiryDays * 86400000).toISOString();

    /* ----------------- Step 8: Create in Shopify via GraphQL ----------------- */
    const gql = await createShopifyDiscount(client, code, clean, expiryIso);

    const userErrors =
      gql?.body?.data?.discountCodeBasicCreate?.userErrors || [];

    if (userErrors.length > 0) {
      console.error("❌ Shopify GraphQL errors:", userErrors);
      return res.status(400).json({
        success: false,
        error: "Shopify API error",
        details: userErrors.map((e) => e.message),
      });
    }

    /* ----------------- Step 9: Save in Prisma ----------------- */
    const saved = await prisma.discount.create({
      data: {
        shopId: shop.id,
        userId: clean.userId,
        email: clean.email,
        code,
        type: clean.type,
        amount: clean.amount,
        expiresAt: new Date(expiryIso),
      },
    });

    /* ----------------- Step 10: Return ----------------- */
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