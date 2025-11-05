import express from "express";
import cookieParser from "cookie-parser";
import dotenv from "dotenv";
import { shopifyApi } from "@shopify/shopify-api";
import "@shopify/shopify-api/adapters/node";
import { PrismaClient } from "@prisma/client";

dotenv.config();

const prisma = new PrismaClient();
const router = express.Router();
router.use(cookieParser());

// ✅ Initialize Shopify API
const shopify = shopifyApi({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET,
  scopes: process.env.SHOPIFY_SCOPES.split(","),
  hostName: process.env.APP_URL.replace(/https?:\/\//, ""),
  apiVersion: process.env.SHOPIFY_API_VERSION || "2024-07",
  isEmbeddedApp: true,
});


// === STEP 1: Begin OAuth flow safely (handles iframe issues) ===
router.get("/auth", async (req, res) => {
  const shop = req.query.shop;

  if (!shop) {
    return res.status(400).send("Missing ?shop parameter");
  }

  // If browser has no top-level access (like iframe), redirect to /auth/toplevel
  const query = new URLSearchParams({ shop }).toString();
  const topLevelUrl = `/auth/toplevel?${query}`;

  res.send(`
    <html>
      <body>
        <script type="text/javascript">
          window.top.location.href = "${topLevelUrl}";
        </script>
      </body>
    </html>
  `);
});

// === STEP 2: Redirect merchant outside iframe, then start OAuth install ===
router.get("/auth/toplevel", async (req, res) => {
  const shop = req.query.shop;

  if (!shop) {
    return res.status(400).send("Missing ?shop parameter");
  }

  const redirectUrl = `/auth/install?shop=${shop}`;
  console.log("🔁 Redirecting to install from top-level context:", redirectUrl);

  res.redirect(redirectUrl);
});

// ===========================================================
// 🔑 AUTH INSTALL
// ===========================================================
router.get("/auth/install", async (req, res) => {
  try {
    const shop = req.query.shop;
    if (!shop) return res.status(400).send("Missing ?shop parameter");

    console.log(`🌀 Starting OAuth for shop: ${shop}`);

    const authUrl = await shopify.auth.begin({
      shop,
      callbackPath: "/auth/callback",
      isOnline: false,
      rawRequest: req,
      rawResponse: res,
    });

  
    if (!res.headersSent) {
      console.log("🛠️ Redirecting to:", authUrl);
      return res.redirect(authUrl);
    }
  } catch (err) {
    console.error("OAuth install error:", err);
    if (!res.headersSent) res.status(500).send("Error during OAuth install");
  }
});

// ===========================================================
// 🔑 AUTH CALLBACK
// ===========================================================
router.get("/auth/callback", async (req, res) => {
  try {
    const { session } = await shopify.auth.callback({
      rawRequest: req,
      rawResponse: res,
    });

    if (!session) {
      console.error("❌ No session returned from OAuth callback");
      return res.status(500).send("No session returned from Shopify OAuth");
    }

    const shopDomain = session.shop;
    const accessToken = session.accessToken;

    console.log("✅ OAuth success for shop:", shopDomain);
    console.log("🔑 Access token:", accessToken);

    // =======================================================
    // 🔔 Automatically register the "orders/create" webhook
    // =======================================================
    try {
      console.log(`🔔 Registering webhook for ${shopDomain}...`);

      const client = new shopify.clients.Rest({
        session: {
          shop: shopDomain,
          accessToken: accessToken,
        },
      });

      const webhookAddress = `${process.env.HOST}/api/webhooks/orders-create`;

      await client.post({
        path: "webhooks",
        data: {
          webhook: {
            topic: "orders/create",
            address: webhookAddress,
            format: "json",
          },
        },
        type: "application/json",
      });

      console.log(`✅ Webhook registered for ${shopDomain}: ${webhookAddress}`);
    } catch (error) {
      console.error("❌ Failed to register webhook:", error);
    }

    // =======================================================
    // 💾 Save or update the shop record in your DB
    // =======================================================
    await prisma.shop.upsert({
      where: { shopDomain },
      update: {
        accessToken,
        scope: session.scope || "",
        updatedAt: new Date(),
      },
      create: {
        shopDomain,
        accessToken,
        scope: session.scope || "",
      },
    });

    res.send(`✅ App installed successfully on ${shopDomain}`);
  } catch (err) {
    console.error("OAuth callback error:", err);
    res.status(500).send("OAuth callback failed");
  }
});

export default router;