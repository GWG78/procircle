import express from "express";
import cookieParser from "cookie-parser";
import dotenv from "dotenv";
import { PrismaClient } from "@prisma/client";
import { shopify } from "./shopify.js";


dotenv.config();

const prisma = new PrismaClient();
const router = express.Router();
router.use(cookieParser());

// Matches Shopify's own shop-domain format. Rejecting anything else here —
// before it ever reaches shopify.auth.begin() or gets redirected to as a
// URL — closes off using this route as an open redirect via an arbitrary
// ?shop= value.
const SHOP_DOMAIN_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/;

// ===========================================================
// 1️⃣ START OAUTH (via /auth)
//
// This is Shopify's actual entry point — hit directly by a plain browser
// GET from an "Install" link or the App Store, with only ?shop= (never
// ?host=, which only exists once the app is already loaded inside the
// Admin iframe — requiring it here made this route unreachable on every
// fresh install, including via this app's own index.js, which redirects
// here with shop only). No auth required, by design: this *is* how a
// merchant proves they want to install by directing their own browser to
// their own shop's OAuth consent screen.
// ===========================================================
router.get("/auth", async (req, res) => {
  const { shop } = req.query;

  if (!shop || typeof shop !== "string" || !SHOP_DOMAIN_PATTERN.test(shop)) {
    return res.status(400).send("Missing or invalid ?shop — expected a *.myshopify.com domain");
  }

  try {
    const authUrl = await shopify.auth.begin({
      shop,
      callbackPath: "/auth/callback",
      isOnline: false,
      rawRequest: req,
      rawResponse: res,
    });

    if (!res.headersSent) return res.redirect(authUrl);
  } catch (err) {
    console.error("OAuth begin error:", err);
    return res.status(500).send("OAuth install failed");
  }
});

// ===========================================================
// 2️⃣ TOP-LEVEL REDIRECT (avoids iframe issues)
//
// Kept as a secondary entry point for anything that still links to it
// directly (e.g. a top-level-navigation bounce from inside an iframe) —
// /auth above no longer depends on this hop.
// ===========================================================
router.get("/auth/toplevel", (req, res) => {
  const { shop } = req.query;
  if (!shop) return res.status(400).send("Missing shop");

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

    // Land the merchant back inside the Shopify Admin iframe, not on this
    // app's bare server URL — the standard, App-Store-expected post-install
    // destination for an embedded app. Previously redirected to this app's
    // own "/" directly, which would have loaded outside the Admin.
    return res.redirect(`https://${shopDomain}/admin/apps/${process.env.SHOPIFY_API_KEY}`);

  } catch (err) {
    console.error("❌ OAuth callback error:", err);
    return res.status(500).send("OAuth callback failed");
  }
});

export default router;

console.log("AUTH.MJS LOADED");