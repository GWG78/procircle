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
   2. Setup Shopify API (GraphQL)
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
   3. Validate incoming payload
   ============================================================ */
function validateDiscountPayload(body) {
  const errors = [];
  const amount = Number(body.amount);

  if (!body.shopDomain) errors.push("shopDomain required");
  if (!body.userId) errors.push("userId required");
  if (!body.email) errors.push("email required");
  if (isNaN(amount) || amount <= 0) errors.push("Invalid amount");

  return {
    errors,
    clean: {
      shopDomain: body.shopDomain,
      userId: body.userId,
      email: body.email,
      name: body.name || "",
      amount,
      type: "percentage", // forced
      expiryDays: body.expiryDays ?? null,
      maxDiscounts: body.maxDiscounts ?? null,
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
   4. Get Shopify GraphQL client
   ============================================================ */
function getGQLClient(shop, accessToken) {
  return new shopify.clients.Graphql({
    session: {
      shop,
      accessToken,
    },
  });
}

/* ============================================================
   5. Convert category handles → Shopify GraphQL IDs
   ============================================================ */
async function fetchCollectionIds(shopDomain, accessToken, handles) {
  if (!handles?.length) return [];

  const client = new shopify.clients.Graphql({
    session: { shop: shopDomain, accessToken },
  });

  const ids = [];

  for (const handle of handles) {
    const query = `
      query GetCollection($handle: String!) {
        collection(handle: $handle) {
          id
        }
      }
    `;

    const result = await client.query({
      data: { query, variables: { handle } },
    });

    const id = result?.body?.data?.collection?.id;
    if (id) ids.push(id);
  }

  return ids;
}

/* ============================================================
   6. MAIN ENDPOINT — POST /api/discounts/create
   ============================================================ */
router.post("/create", async (req, res) => {
  try {
    // Step 1 — Validate
    const { errors, clean } = validateDiscountPayload(req.body);
    if (errors.length) {
      return res.status(400).json({ success: false, error: errors.join(", ") });
    }

    // Step 2 — Load shop + settings
    const shop = await prisma.shop.findUnique({
      where: { shopDomain: clean.shopDomain },
      include: { settings: true },
    });

    if (!shop) {
      return res.status(404).json({ success: false, error: "Shop not found" });
    }

    const settings = shop.settings || {};

    // Step 3 — Eligibility Checks
    if (settings.allowedCountries?.length) {
      if (!clean.allowedCountries.some(c => settings.allowedCountries.includes(c))) {
        return res.status(403).json({ success: false, error: "Country not allowed" });
      }
    }

    if (settings.allowedMemberTypes?.length) {
      if (!clean.allowedMemberTypes.some(t => settings.allowedMemberTypes.includes(t))) {
        return res.status(403).json({ success: false, error: "Member type not allowed" });
      }
    }

    // Step 4 — Prevent user duplicates
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

    // Max limits
    if (settings.maxDiscounts) {
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

    // Step 5 — Lookup collection IDs
    const collectionIds = await fetchCollectionIds(
      shop.shopDomain,
      shop.accessToken,
      settings.categories
    );

    // Step 6 — Build discount code
    const code = generateDiscountCode(clean.name);

    const startsAt = new Date().toISOString();
    const expiryDays = clean.expiryDays ?? settings.expiryDays ?? 30;
    const endsAt = new Date(Date.now() + expiryDays * 86400000).toISOString();

    // Step 7 — GraphQL mutation
    const gql = getGQLClient(shop.shopDomain, shop.accessToken);

    const mutation = `
      mutation CreateBasicDiscount($discount: DiscountCodeBasicInput!) {
        discountCodeBasicCreate(basicCodeDiscount: $discount) {
          codeDiscountNode {
            id
            codeDiscount {
              ... on DiscountCodeBasic {
                title
                codes { code }
              }
            }
          }
          userErrors { field message }
        }
      }
    `;

    const variables = {
      discount: {
        title: `ProCircle ${code}`,
        code,
        startsAt,
        endsAt,
        customerSelection: { all: true },
        appliesOncePerCustomer: clean.oneTimeUse,
        usageLimit: clean.oneTimeUse ? 1 : null,
        combinesWith: {
          productDiscounts: true,
          orderDiscounts: false,
          shippingDiscounts: false,
        },
        customerGets: {
          value: {
            percentageValue: clean.amount,
          },
          items: collectionIds.length
            ? { collections: { add: collectionIds } }
            : { all: true },
        },
      },
    };

    const response = await gql.query({ data: { query: mutation, variables } });

    const errorsGQL =
      response?.body?.data?.discountCodeBasicCreate?.userErrors;

    if (errorsGQL?.length) {
      return res.status(400).json({
        success: false,
        error: "Shopify rejected the discount",
        details: errorsGQL,
      });
    }

    // Extract code (Shopify returns it)
    const savedCode =
      response.body.data.discountCodeBasicCreate.codeDiscountNode
        .codeDiscount.codes[0].code;

    // Step 8 — Save in DB
    const saved = await prisma.discount.create({
      data: {
        shopId: shop.id,
        userId: clean.userId,
        email: clean.email,
        code: savedCode,
        type: "percentage",
        amount: clean.amount,
        expiresAt: new Date(endsAt),
      },
    });

    return res.json({ success: true, discount: saved });

  } catch (err) {
    console.error("❌ Discount creation failed:", err);
    return res.status(500).json({
      success: false,
      error: "Shopify discount creation failed",
      details: err.message,
    });
  }
});

export default router;