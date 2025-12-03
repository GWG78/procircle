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
   3. VALIDATION
   ============================================================ */
function validateDiscountPayload(body) {
  const errors = [];

  if (!body.shopDomain) errors.push("shopDomain required");
  if (!body.userId) errors.push("userId required");
  if (!body.email) errors.push("email required");

  // percentage only
  const amount = Number(body.amount);
  if (isNaN(amount) || amount <= 0 || amount > 100) {
    errors.push("amount must be 1–100 (percentage only)");
  }

  const expiryDays =
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
   4. GRAPHQL V2 MUTATION (NEW)
   ============================================================ */
const DISCOUNT_BASIC_V2 = `
mutation CreateDiscount($input: DiscountCodeBasicInput!) {
  discountCodeBasicCreateV2(basicCodeDiscount: $input) {
    codeDiscount {
      ... on DiscountCodeBasic {
        title
        startsAt
        endsAt
        codes(first: 1) { nodes { code } }
      }
    }
    userErrors { field message }
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
      return res.status(400).json({ success: false, errors });
    }

    /* --- Load shop + settings --- */
    const shop = await prisma.shop.findUnique({
      where: { shopDomain: clean.shopDomain },
      include: { settings: true },
    });

    if (!shop) {
      return res.status(404).json({ success: false, error: "Shop not found" });
    }

    const settings = shop.settings || {};

    /* --- Allowed country gating --- */
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

    /* --- Allowed member type gating --- */
    if (settings.allowedMemberTypes?.length) {
      if (!clean.allowedMemberTypes.some((t) =>
        settings.allowedMemberTypes.includes(t)
      )) {
        return res.status(403).json({
          success: false,
          error: "Member type not allowed",
        });
      }
    }

    /* --- One code per user enforcement --- */
    const existing = await prisma.discount.findFirst({
      where: { shopId: shop.id, userId: clean.userId },
    });

    if (existing) {
      return res
        .status(409)
        .json({ success: false, error: "User already has a discount" });
    }

    /* --- Max discount enforcement --- */
    if (settings.maxDiscounts && settings.maxDiscounts > 0) {
      const total = await prisma.discount.count({
        where: { shopId: shop.id },
      });
      if (total >= settings.maxDiscounts) {
        return res.status(429).json({
          success: false,
          error: "Maximum number of discounts reached",
        });
      }
    }

    /* --- Expiry --- */
    const expiryDays = clean.expiryDays ?? settings.expiryDays ?? 30;
    const endsAt = new Date(
      Date.now() + expiryDays * 86400000
    ).toISOString();
    const startsAt = new Date().toISOString();

    /* --- Resolve collection handles → GIDs --- */
    const collectionGids = await getCollectionGids(shop, settings.categories);

    /* --- Assemble discount code --- */
    const code = generateDiscountCode(clean.name);

    /* --- Prepare Shopify GraphQL client --- */
    const client = new shopify.clients.Graphql({
      session: {
        shop: shop.shopDomain,
        accessToken: shop.accessToken,
      },
    });

    /* --- Build V2 input --- */
    const input = {
      title: `ProCircle-${code}`,
      code,
      startsAt,
      endsAt,
      usageLimit: clean.oneTimeUse ? 1 : null,

      customerSelection: { all: true },

      customerGets: {
        value: { percentageValue: clean.amount },
      },

      appliesTo: collectionGids.length
        ? { collectionsToAdd: collectionGids }
        : { all: true },
    };

    /* --- Send GraphQL mutation --- */
    const gqlRes = await client.query({
      data: {
        query: DISCOUNT_BASIC_V2,
        variables: { input },
      },
    });

    const userErrors =
      gqlRes.body.data.discountCodeBasicCreateV2.userErrors;

    if (userErrors?.length) {
      return res.status(400).json({
        success: false,
        error: "Shopify validation error",
        details: userErrors,
      });
    }

    /* --- Save in database --- */
    const saved = await prisma.discount.create({
      data: {
        shopId: shop.id,
        userId: clean.userId,
        email: clean.email,
        code,
        amount: clean.amount,
        type: "percentage",
        expiresAt: new Date(endsAt),
      },
    });

    return res.json({ success: true, discount: saved });
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
   Helper: Resolve collection handles → GIDs
   ============================================================ */
async function getCollectionGids(shop, handles) {
  if (!handles.length) return [];

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
    } catch (err) {
      console.warn("Failed resolving collection:", h);
    }
  }

  return gids;
}

export default router;