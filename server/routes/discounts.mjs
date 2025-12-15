// server/routes/discounts.mjs
import express from "express";
import { PrismaClient } from "@prisma/client";
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
   2. PAYLOAD VALIDATION
   ============================================================ */
function validateDiscountPayload(body) {
  const errors = [];

  if (!body.shopDomain) errors.push("shopDomain required");
  if (!body.userId) errors.push("userId required");
  if (!body.email) errors.push("email required");

  // percentage only: 1–100 from Sheets
  const amount = Number(body.amount);
  if (isNaN(amount) || amount <= 0 || amount > 100) {
    errors.push("amount must be percentage between 1–100");
  }

  // expiryDays: 1–365 or null
  const expiryDays =
    body.expiryDays == null
      ? null
      : Math.max(1, Math.min(365, Number(body.expiryDays)));

  return {
    errors,
    clean: {
      shopDomain: String(body.shopDomain || "").trim(),
      userId: String(body.userId || "").trim(),
      email: String(body.email || "").trim(),
      name: body.name || "",
      amount,
      expiryDays,
      maxDiscounts: body.maxDiscounts == null ? null : Number(body.maxDiscounts),
      oneTimeUse: !!body.oneTimeUse,
      categories: Array.isArray(body.categories) ? body.categories : [],
      allowedCountries: Array.isArray(body.allowedCountries) ? body.allowedCountries : [],
      allowedMemberTypes: Array.isArray(body.allowedMemberTypes) ? body.allowedMemberTypes : [],
    },
  };
}

/* ============================================================
   3. SHOPIFY GRAPHQL HELPERS (RAW FETCH — avoids deprecated client)
   ============================================================ */
async function shopifyGraphQL({ shopDomain, accessToken, query, variables }) {
  const endpoint = `https://${shopDomain}/admin/api/2024-10/graphql.json`;

  const resp = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": accessToken,
    },
    body: JSON.stringify({ query, variables }),
  });

  const text = await resp.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    return {
      ok: false,
      error: "Malformed response from Shopify GraphQL",
      details: text.slice(0, 1000),
    };
  }

  if (!resp.ok) {
    return {
      ok: false,
      error: "Shopify GraphQL HTTP error",
      details: json,
    };
  }

  if (json.errors?.length) {
    return {
      ok: false,
      error: "Shopify GraphQL returned errors",
      details: json.errors,
    };
  }

  return { ok: true, data: json.data };
}

/* ============================================================
   4. MUTATIONS / QUERIES
   ============================================================ */
const DISCOUNT_BASIC_CREATE = `
mutation CreateBasicDiscount($basicCodeDiscount: DiscountCodeBasicInput!) {
  discountCodeBasicCreate(basicCodeDiscount: $basicCodeDiscount) {
    codeDiscountNode {
      id
      codeDiscount {
        ... on DiscountCodeBasic {
          title
          startsAt
          endsAt
          codes(first: 1) { nodes { code } }
        }
      }
    }
    userErrors { field message }
  }
}
`;

const COLLECTION_BY_HANDLE = `
query CollectionByHandle($handle: String!) {
  collectionByHandle(handle: $handle) { id }
}
`;

/* ============================================================
   5. RESOLVE COLLECTION HANDLES → GIDs (GraphQL)
   ============================================================ */
async function resolveCollectionGids(shopDomain, accessToken, handles) {
  if (!handles || !handles.length) return [];

  const gids = [];

  for (const h of handles) {
    const handle = String(h || "").trim();
    if (!handle) continue;

    const r = await shopifyGraphQL({
      shopDomain,
      accessToken,
      query: COLLECTION_BY_HANDLE,
      variables: { handle },
    });

    if (r.ok && r.data?.collectionByHandle?.id) {
      gids.push(r.data.collectionByHandle.id);
    } else {
      console.warn("Failed to resolve collection handle:", handle, r.details || r.error);
    }
  }

  return gids;
}

/* ============================================================
   6. MAIN ENDPOINT — POST /api/discounts/create
   ============================================================ */
router.post("/create", async (req, res) => {
  try {
    const { errors, clean } = validateDiscountPayload(req.body || {});
    if (errors.length) {
      return res.status(400).json({
        success: false,
        error: "Validation failed",
        details: errors,
      });
    }

    // Load shop + settings
    const shop = await prisma.shop.findUnique({
      where: { shopDomain: clean.shopDomain },
      include: { settings: true },
    });

    if (!shop) {
      return res.status(404).json({ success: false, error: "Shop not found" });
    }

    const settings = shop.settings || {};

    // OPTIONAL FAILSAFE GATES (disabled while WP handles filtering)
    // if (settings.allowedCountries?.length) {
    //   if (!clean.allowedCountries.some((c) => settings.allowedCountries.includes(c))) {
    //     return res.status(403).json({ success: false, error: "Country not allowed" });
    //   }
    // }
    // if (settings.allowedMemberTypes?.length) {
    //   if (!clean.allowedMemberTypes.some((t) => settings.allowedMemberTypes.includes(t))) {
    //     return res.status(403).json({ success: false, error: "Member type not allowed" });
    //   }
    // }

    // Prevent duplicates (local DB)
    const existing = await prisma.discount.findFirst({
      where: { shopId: shop.id, userId: clean.userId },
    });

    if (existing) {
      return res.status(409).json({
        success: false,
        error: "User already has a discount",
      });
    }

    // MaxDiscounts enforcement
    if (settings.maxDiscounts && settings.maxDiscounts > 0) {
      const issued = await prisma.discount.count({ where: { shopId: shop.id } });
      if (issued >= settings.maxDiscounts) {
        return res.status(429).json({
          success: false,
          error: "Max number of discounts reached",
        });
      }
    }

    // Expiry
    const expiryDays = clean.expiryDays ?? settings.expiryDays ?? 30;
    const endsAt = new Date(Date.now() + expiryDays * 86400000).toISOString();
    const startsAt = new Date().toISOString();

    // Code
    const code = generateDiscountCode(clean.name);

    // Collections optional
    const collectionGids = await resolveCollectionGids(
      shop.shopDomain,
      shop.accessToken,
      settings.categories || []
    );

    // IMPORTANT: Shopify expects decimal for percentage (0.30 = 30%)
    const percentageDecimal = clean.amount / 100;

    const basicCodeDiscount = {
      title: `ProCircle-${code}`,
      code,
      startsAt,
      endsAt,
      usageLimit: clean.oneTimeUse ? 1 : null,
      appliesOncePerCustomer: false, // change if you want 1 use per customer
      customerSelection: { all: true },
      customerGets: {
        value: { percentage: percentageDecimal },
        items: collectionGids.length
          ? { collections: { collectionsToAdd: collectionGids } }
          : { all: true },
      },
    };

    const gql = await shopifyGraphQL({
      shopDomain: shop.shopDomain,
      accessToken: shop.accessToken,
      query: DISCOUNT_BASIC_CREATE,
      variables: { basicCodeDiscount },
    });

    if (!gql.ok) {
      return res.status(500).json({
        success: false,
        error: gql.error || "Shopify discount creation failed",
        details: gql.details,
      });
    }

    const result = gql.data?.discountCodeBasicCreate;
    if (!result) {
      return res.status(500).json({
        success: false,
        error: "Malformed Shopify response",
        details: gql.data,
      });
    }

    if (result.userErrors?.length) {
      return res.status(400).json({
        success: false,
        error: "Shopify error",
        details: result.userErrors,
      });
    }

    // Save locally
    const saved = await prisma.discount.create({
      data: {
        shopId: shop.id,
        userId: clean.userId,
        email: clean.email,
        code,
        type: "percentage",
        amount: clean.amount,
        expiresAt: new Date(endsAt),
      },
    });

    return res.json({ success: true, discount: saved });
  } catch (err) {
    console.error("❌ Discount creation error:", err);
    return res.status(500).json({
      success: false,
      error: "Shopify discount creation failed",
      details: err?.message || String(err),
    });
  }
});

/* ============================================================
   7. Sync Redeemed vouchers to sheets
   ============================================================ */

router.get("/unsynced", async (req, res) => {
  try {
    const rows = await prisma.discount.findMany({
      where: { syncedToSheets: false, redeemedAt: { not: null } },
    });
    return res.json({ success: true, rows });
  } catch (err) {
    console.error("Error fetching unsynced:", err);
    return res.status(500).json({
      success: false,
      error: "Failed to load unsynced discounts",
    });
  }
});

router.post("/mark-synced", async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) {
      return res.status(400).json({ success: false, error: "Missing code" });
    }

    await prisma.discount.update({
      where: { code },
      data: { syncedToSheets: true },
    });

    return res.json({ success: true });
  } catch (err) {
    console.error("Mark synced error:", err);
    return res.status(500).json({
      success: false,
      error: "Failed to mark synced",
    });
  }
});

export default router;