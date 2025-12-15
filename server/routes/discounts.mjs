// server/routes/discounts.mjs
import express from "express";
import { PrismaClient } from "@prisma/client";
import { shopifyApi } from "@shopify/shopify-api";
import { generateDiscountCode } from "../utils/generateCode.js";

const prisma = new PrismaClient();
const router = express.Router();

/* ============================================================
   1. INTERNAL API KEY VALIDATION
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
   2. SHOPIFY API CLIENT
   ============================================================ */
const shopify = shopifyApi({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET,
  scopes: process.env.SHOPIFY_SCOPES.split(","),
  hostName: process.env.APP_URL.replace(/https?:\/\//, ""),
  apiVersion: "2024-10",
  isEmbeddedApp: true,
});


/* ============================================================
   3. PAYLOAD VALIDATION
   ============================================================ */
function validateDiscountPayload(body) {
  const errors = [];

  if (!body.shopDomain) errors.push("shopDomain required");
  if (!body.userId) errors.push("userId required");
  if (!body.email) errors.push("email required");

  // percentage only
  const amount = Number(body.amount);
  if (isNaN(amount) || amount <= 0 || amount > 100) {
    errors.push("amount must be percentage between 1–100");
  }

  let expiryDays =
    body.expiryDays == null
      ? null
      : Math.max(1, Math.min(365, Number(body.expiryDays)));

  return {
    errors,
    clean: {
      shopDomain: body.shopDomain,
      userId: body.userId,
      email: body.email,
      name: body.name || "",
      amount,
      expiryDays,
      maxDiscounts:
        body.maxDiscounts == null ? null : Number(body.maxDiscounts),
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
   4. FINAL SHOPIFY GRAPHQL MUTATION
   ============================================================ */
const DISCOUNT_CREATE_MUTATION = `
mutation discountCreate($discount: DiscountCodeCreateInput!) {
  discountCreate(codeDiscount: $discount) {
    codeDiscountNode {
      id
      codeDiscount {
        ... on DiscountCode {
          title
          startsAt
          endsAt
          codes(first: 1) {
            nodes { code }
          }
        }
      }
    }
    userErrors {
      field
      message
    }
  }
}
`;

/* ============================================================
   5. MAIN ENDPOINT — POST /api/discounts/create
   ============================================================ */
router.post("/create", async (req, res) => {
  try {
    /* --- Validate --- */
    const { errors, clean } = validateDiscountPayload(req.body || {});
    if (errors.length) {
      return res.status(400).json({
        success: false,
        error: "Validation failed",
        details: errors,
      });
    }

    /* --- Load shop --- */
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

    /* --- Allowed filters --- 
    if (settings.allowedCountries?.length) {
      if (!clean.allowedCountries.some((c) =>
        settings.allowedCountries.includes(c)
      )) {
        return res.status(403).json({
          success: false,
          error: "Country not allowed",
        });
      }
    }

    if (settings.allowedMemberTypes?.length) {
      if (!clean.allowedMemberTypes.some((t) =>
        settings.allowedMemberTypes.includes(t)
      )) {
        return res.status(403).json({
          success: false,
          error: "Member type not allowed",
        });
      }
    }*/

    /* --- Prevent duplicates --- */
    const existing = await prisma.discount.findFirst({
      where: {
        shopId: shop.id,
        userId: clean.userId,
      },
    });

    if (existing) {
      return res.status(409).json({
        success: false,
        error: "User already has a discount",
      });
    }

    /* --- MaxDiscounts enforcement --- */
    if (settings.maxDiscounts && settings.maxDiscounts > 0) {
      const issued = await prisma.discount.count({
        where: { shopId: shop.id },
      });

      if (issued >= settings.maxDiscounts) {
        return res.status(429).json({
          success: false,
          error: "Max number of discounts reached",
        });
      }
    }

    /* --- Expiry --- */
    const expiryDays = clean.expiryDays ?? settings.expiryDays ?? 30;
    const expiresAt = new Date(
      Date.now() + expiryDays * 86400000
    ).toISOString();

    /* --- Build code --- */
    const code = generateDiscountCode(clean.name);
    const startsAt = new Date().toISOString();

    /* --- Resolve collections --- */
    const collectionGids = await resolveCollectionGids(
      shop,
      settings.categories || []
    );

    /* --- Build mutation input --- */
    const discountInput = {
      title: `ProCircle-${code}`,
      startsAt,
      endsAt: expiresAt,

      combinesWith: {
        orderDiscounts: false,
        productDiscounts: false,
        shippingDiscounts: false,
      },

      customerSelection: { all: true },

      code: code,

      usageLimit: clean.oneTimeUse ? 1 : null,

      appliesTo: collectionGids.length
        ? { collectionsToAdd: collectionGids }
        : { all: true },

      customerGets: {
        value: {
          percentage: {
            value: clean.amount,
          },
        },
      },
    };

    /* --- Shopify GraphQL Client --- */
    const gqlClient = new shopify.clients.Graphql({
      session: {
        shop: shop.shopDomain,
        accessToken: shop.accessToken,
      },
    });

    const gqlRes = await gqlClient.query({
      data: {
        query: DISCOUNT_CREATE_MUTATION,
        variables: { discount: discountInput },
      },
    });

    /* --- Handle Shopify errors --- */
    const userErrors = gqlRes.body.data.discountCreate.userErrors;
    if (userErrors?.length) {
      return res.status(400).json({
        success: false,
        error: "Shopify error",
        details: userErrors,
      });
    }

    /* --- Save locally --- */
    const saved = await prisma.discount.create({
      data: {
        shopId: shop.id,
        userId: clean.userId,
        email: clean.email,
        code,
        type: "percentage",
        amount: clean.amount,
        expiresAt: new Date(expiresAt),
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

/* ============================================================
   6. RESOLVE COLLECTION HANDLES → GIDs
   ============================================================ */
async function resolveCollectionGids(shop, handles) {
  if (!handles || !handles.length) return [];

  const client = new shopify.clients.Rest({
    session: {
      shop: shop.shopDomain,
      accessToken: shop.accessToken,
    },
  });

  const gids = [];

  for (const h of handles) {
    try {
      const res = await client.get({
        path: "collections",
        query: { handle: h },
      });

      const c = res.body?.collection;
      if (c?.id) {
        gids.push(`gid://shopify/Collection/${c.id}`);
      }
    } catch (e) {
      console.warn("Failed to resolve collection:", h);
    }
  }

  return gids;
}

/* ============================================================
   8. Sync Redeemed voucehers to sheets
   ============================================================ */

router.get("/unsynced", async (req, res) => {
  try {
    const rows = await prisma.discount.findMany({
      where: { syncedToSheets: false, redeemedAt: { not: null } }
    });
    return res.json({ success: true, rows });
  } catch (err) {
    console.error("Error fetching unsynced:", err);
    return res.status(500).json({
      success: false,
      error: "Failed to load unsynced discounts"
    });
  }
});

router.post("/mark-synced", async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ success: false, error: "Missing code" });

    await prisma.discount.update({
      where: { code },
      data: { syncedToSheets: true }
    });

    return res.json({ success: true });
  } catch (err) {
    console.error("Mark synced error:", err);
    return res.status(500).json({
      success: false,
      error: "Failed to mark synced"
    });
  }
});

export default router;