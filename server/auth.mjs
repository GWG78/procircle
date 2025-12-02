import express from "express";
import cookieParser from "cookie-parser";
import dotenv from "dotenv";
import { PrismaClient } from "@prisma/client";
import { shopify } from "./shopify.js";

import { shopify } from "./shopify.js"; // ← We will create this
// This imports the SINGLE shared Shopify API instance

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
  try {
    const result = await shopify.auth.callback({
      rawRequest: req,
      rawResponse: res,
    });

    const session = result.session;
    if (!session) return res.status(500).send("No session returned");

    const shopDomain = session.shop;
    const accessToken = session.accessToken;

    // Save or update shop record
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

    return res.send(`✅ App installed on ${shopDomain}`);

  } catch (err) {
    console.error("OAuth callback error:", err);
    return res.status(500).send("OAuth callback failed");
  }
});

export default router;