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
    console.log("🧩 Incoming /auth/callback query:", req.query);

    const result = await shopify.auth.callback({
      rawRequest: req,
      rawResponse: res,
    });

    console.log("🧩 shopify.auth.callback() result:", result);

    const session = result?.session;

    if (!session) {
      console.error("❌ No session returned from OAuth callback");
      return res.status(500).send("No session returned from Shopify OAuth");
    }

    const shopDomain = session.shop;
    const accessToken = session.accessToken;

    console.log("✅ OAuth success for shop:", shopDomain);
    console.log("🔑 Access token:", accessToken);

    // =======================================================
    // 💾 Save or update the shop record in your DB
    // =======================================================
    await prisma.shop.upsert({
      where: { shopDomain },
      update: {
        accessToken,
        scope: session.scope || "",
        installed: true,
        updatedAt: new Date(),
      },
      create: {
        shopDomain,
        accessToken,
        scope: session.scope || "",
        installed: true,
      },
    });

    console.log(`💾 Saved shop record for ${shopDomain}`);

    // =======================================================
    // 🔔 Automatically register the "orders/create" webhook
    // =======================================================
    try {
      console.log(`🔔 Registering orders/create webhook for ${shopDomain}...`);

      const ordersClient = new shopify.clients.Rest({
        session: { shop: shopDomain, accessToken },
      });

      const ordersWebhook = `${process.env.APP_URL}/api/webhooks/orders-create`;

      await ordersClient.post({
        path: "webhooks",
        data: {
          webhook: {
            topic: "orders/create",
            address: ordersWebhook,
            format: "json",
          },
        },
        type: "application/json",
      });

      console.log(`✅ Registered orders/create webhook: ${ordersWebhook}`);
    } catch (error) {
      console.error("❌ Failed to register orders webhook:", error);
    }

    // =======================================================
    // 🔔 Register APP_UNINSTALLED webhook
    // =======================================================
    try {
      console.log(`🔔 Registering app/uninstalled webhook for ${shopDomain}...`);

      const uninstallClient = new shopify.clients.Rest({
        session: { shop: shopDomain, accessToken },
      });

      const uninstallWebhook = `${process.env.APP_URL}/api/webhooks/app-uninstalled`;

      await uninstallClient.post({
        path: "webhooks",
        data: {
          webhook: {
            topic: "app/uninstalled",
            address: uninstallWebhook,
            format: "json",
          },
        },
        type: "application/json",
      });

      console.log(`✅ Registered app/uninstalled webhook: ${uninstallWebhook}`);
    } catch (error) {
      console.error("❌ Failed to register APP_UNINSTALLED webhook:", error);
    }

    res.send(`✅ App installed successfully on ${shopDomain}`);
  } catch (err) {
    console.error("OAuth callback error:", err);
    res.status(500).send("OAuth callback failed");
  }
});

export default router;