console.log("🚨 INDEX.JS VERSION 2025-01-ENSURE-REMOVED");
// =============================================
// 🌍 Load environment variables
// =============================================

import dotenv from "dotenv";
dotenv.config();

console.log("🔑 API KEY:", process.env.SHOPIFY_API_KEY?.slice(0, 6));
console.log("🔑 API SECRET:", process.env.SHOPIFY_API_SECRET ? "SET" : "MISSING");

// =============================================
// 🧠 Imports
// =============================================
import express from "express";
import cookieParser from "cookie-parser";
import session from "express-session";

import "@shopify/shopify-api/adapters/node";

import authRoutes from "./auth.mjs";
import webhookRoutes from "./routes/webhooks.mjs";
import settingsRouter from "./routes/settings.mjs";
import redemptionRoutes from "./routes/redemptions.mjs";
import collectionsRoutes from "./routes/collections.mjs";
import campaignRoutes from "./routes/campaigns.mjs";
import memberRoutes from "./routes/members.mjs";

import path from "path";
import { fileURLToPath } from "url";

import { shopify } from "./shopify.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

// =============================================
// payment testing
// 
import { convertCurrency } from "./services/currencyService.js";
import { postUsageRecord } from "./services/usageRecord.js";
import { fetchActiveSubscription } from "./services/partnerApi.js";
import verifyShopifyAuth from "./middleware/verifyShopifyAuth.js";

// =============================================
// 🚀 Server Setup
// =============================================
const app = express();

// 🚨 MUST COME FIRST (before cookies/sessions)
app.set("trust proxy", true);

const PORT = process.env.PORT || 3001;

console.log("🔧 Loading index.js");

// CORS for Shopify Admin iframe
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "https://admin.shopify.com");
  res.header("Access-Control-Allow-Credentials", "true");
  res.header("Access-Control-Allow-Headers", "Content-Type, X-Requested-With, Authorization");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");

  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

app.use(cookieParser());

prisma.$connect()
  .then(() => console.log("✅ Prisma connected"))
  .catch((e) => console.error("❌ Prisma failed to connect", e));

// =============================================
// 🧠 Session (embedded app requirement)
// =============================================
app.use(
  session({
    name: "shopify_app_session",
    secret: process.env.JWT_SECRET || "supersecretstring",
    resave: false,
    saveUninitialized: false,
    proxy: true,
    cookie: {
      secure: true,
      sameSite: "none",
      httpOnly: true,
    },
  })
);

// JSON parsing (skip webhooks)
app.use((req, res, next) => {
  if (req.originalUrl.startsWith("/api/webhooks")) return next();
  express.json()(req, res, next);
});

// Built React app (web/ -> vite build -> server/public).
// index: false so express.static never auto-serves index.html for "/" —
// that must go through the OAuth/install gate below instead.
app.use(express.static(path.join(__dirname, "public"), { index: false }));

app.get("/__db_test", async (req, res) => {
  try {
    const count = await prisma.shop.count();
    res.json({ ok: true, shopCount: count });
  } catch (err) {
    console.error("❌ DB TEST FAILED:", err);
    res.status(500).json({
      ok: false,
      error: err.message,
    });
  }
});


// TEMPORARY: Shopify App Pricing test
app.post(
  "/api/test-billing-event",
  verifyShopifyAuth,
  async (req, res) => {
    try {
      const shop = req.shopifyShop;

      if (!shop?.shopifyShopId) {
        return res.status(400).json({
          success: false,
          error: "Shopify Shop ID is missing",
        });
      }

      const result = await postUsageRecord(
        shop.shopifyShopId,
        1.0,
        "billing-test-001"
      );

      if (!result) {
        return res.status(500).json({
          success: false,
          error: "Shopify App Event was not accepted",
        });
      }

      return res.json({
        success: true,
        shop: shop.shopDomain,
        shopifyShopId: shop.shopifyShopId,
        result,
      });
    } catch (err) {
      console.error("❌ Billing test endpoint error:", err);

      return res.status(500).json({
        success: false,
        error: err.message,
      });
    }
  }
);

app.get(
  "/api/test-currency",
  verifyShopifyAuth,
  async (req, res) => {
    try {
      const result = await convertCurrency(
        8,
        "EUR",
        "USD"
      );

      console.log("💱 CurrencyAPI test:", result);

      res.json({
        success: true,
        result,
      });
    } catch (err) {
      console.error(
        "❌ CurrencyAPI test failed:",
        err
      );

      res.status(500).json({
        success: false,
        error: err.message,
      });
    }
  }
);

app.get("/api/test-active-subscription", verifyShopifyAuth, async (req, res) => {
  try {
    const shop = req.shopifyShop;

    const subscription = await fetchActiveSubscription(
      shop.shopifyShopId
    );

    console.log(
      `💳 App Pricing subscription for ${shop.shopDomain}:`,
      subscription
    );

    res.json({
      success: true,
      shop: shop.shopDomain,
      shopifyShopId: shop.shopifyShopId,
      activeSubscription: subscription,
    });
  } catch (err) {
    console.error(
      "❌ Active subscription test failed:",
      err?.message || err
    );

    res.status(500).json({
      success: false,
      error: err?.message || "Unknown error",
    });
  }
});

app.get("/api/test-legacy-subscription", verifyShopifyAuth, async (req, res) => {
  try {
    const shop = req.shopifyShop;

    const client = new shopify.clients.Graphql({
      session: {
        shop: shop.shopDomain,
        accessToken: shop.accessToken,
      },
    });

    const response = await client.request(`
      query {
        currentAppInstallation {
          activeSubscriptions {
            id
            name
            status
            test
            lineItems {
              id
              plan {
                pricingDetails {
                  __typename
                }
              }
            }
          }
        }
      }
    `);

    const subscriptions =
      response.data?.currentAppInstallation?.activeSubscriptions ?? [];

    console.log(
      `💳 Legacy Billing API subscriptions for ${shop.shopDomain}:`,
      subscriptions
    );

    res.json({
      success: true,
      shop: shop.shopDomain,
      activeSubscriptions: subscriptions,
    });
  } catch (err) {
    console.error(
      "❌ Legacy subscription test failed:",
      err?.message || err
    );

    res.status(500).json({
      success: false,
      error: err?.message || "Unknown error",
    });
  }
});

// =============================================
// 🧩 ROUTES
// =============================================
console.log("🔧 Mounting auth routes…");
app.use("/", authRoutes);
console.log("🔧 Auth routes mounted!");


app.use("/api/webhooks", webhookRoutes);
app.use("/api/settings", settingsRouter);
app.use("/api/redemptions", redemptionRoutes);
app.use("/api/collections", collectionsRoutes);
app.use("/api/campaigns", campaignRoutes);
app.use("/api/members", memberRoutes);



// =============================================
// 🌟 Embedded App Root
// Shopify-managed installation: always load the
// React app. App Bridge ID-token authentication
// initialises the shop through the API middleware.
// =============================================

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Catch-all: any other non-API/non-auth GET falls through to the React app
// (client-side routing). The OAuth/install gate above only guards the exact
// "/" entry point — this does not re-check shop install state.
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api") || req.path.startsWith("/auth")) {
    return next();
  }
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// =============================================
// 🚀 Start server
// =============================================
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ ProCircle server running on http://localhost:${PORT}`);
});