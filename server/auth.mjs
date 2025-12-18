import express from "express";
import cookieParser from "cookie-parser";
import dotenv from "dotenv";
import { PrismaClient } from "@prisma/client";
import { shopify } from "./shopify.js";


dotenv.config();

const prisma = new PrismaClient();
const router = express.Router();
router.use(cookieParser());

// ===========================================================
// 1️⃣ START OAUTH (via /auth)
// ===========================================================
router.get("/auth", async (req, res) => {
  const shop = req.query.shop;
  if (!shop) return res.status(400).send("Missing ?shop");

  const query = new URLSearchParams({ shop }).toString();
  return res.send(`
    <script>
      window.top.location.href = "/auth/toplevel?${query}";
    </script>
  `);
});

// ===========================================================
// 2️⃣ TOP-LEVEL REDIRECT (avoids iframe issues)
// ===========================================================
router.get("/auth/toplevel", async (req, res) => {
  const shop = req.query.shop;
  if (!shop) return res.status(400).send("Missing ?shop");

  return res.redirect(`/auth/install?shop=${shop}`);
});

// ===========================================================
// 3️⃣ INSTALL ROUTE (begin OAuth)
// ===========================================================
router.get("/auth/install", async (req, res) => {
  try {
    const shop = req.query.shop;
    if (!shop) return res.status(400).send("Missing ?shop");

    const authUrl = await shopify.auth.begin({
      shop,
      callbackPath: "/auth/callback",
      isOnline: false,
      rawRequest: req,
      rawResponse: res,
    });

    if (!res.headersSent) return res.redirect(authUrl);

  } catch (err) {
    console.error("OAuth install error:", err);
    return res.status(500).send("OAuth install failed");
  }
});

// ===========================================================
// 4️⃣ CALLBACK (Shopify sends us a token here)
// ===========================================================
router.get("/auth/callback", async (req, res) => {
  console.log("🔐 OAuth callback hit");
  console.log("🔎 Query:", req.query);

  try {
    const result = await shopify.auth.callback({
      rawRequest: req,
      rawResponse: res,
    });

    console.log("🧾 OAuth result received");

    const session = result.session;
    console.log("📦 Session:", session);

    if (!session) {
      console.error("❌ No session returned");
      return res.status(500).send("No session returned");
    }

    const shopDomain = session.shop;
    const accessToken = session.accessToken;

    console.log("💾 Saving shop", shopDomain);

    await prisma.shop.upsert({
      where: { shopDomain },
      update: {
        accessToken,
        scope: session.scope || "",
        installed: true,
      },
      create: {
        shopDomain,
        accessToken,
        scope: session.scope || "",
        installed: true,
      },
    });

    console.log("✅ Shop saved to database");

    return res.redirect(`/?shop=${shopDomain}`);

  } catch (err) {
    console.error("❌ OAuth callback error:", err);
    return res.status(500).send("OAuth callback failed");
  }
});

export default router;

console.log("AUTH.MJS LOADED");