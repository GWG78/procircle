// ~/procircle/server/middleware/verifyShopifyAuth.js
//
// Verifies the App Bridge session token (Authorization: Bearer <JWT>) sent
// by embedded-admin requests. Deliberately does NOT use shopify.sessionStorage
// — that config option doesn't exist on the installed @shopify/shopify-api
// (v12 dropped it; shopify.sessionStorage is undefined here). Instead this
// verifies the JWT directly (signature + aud + exp/nbf, all handled by
// decodeSessionToken) and resolves the shop from Postgres, which is already
// this app's source of truth for installed shops (see auth.mjs).
import { shopify } from "../shopify.js";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

export default async function verifyShopifyAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization || "";
    const match = authHeader.match(/^Bearer (.+)$/);
    if (!match) {
      return res.status(401).json({ error: "Unauthorized: missing session token" });
    }

    const payload = await shopify.session.decodeSessionToken(match[1]);
    const shopDomain = payload.dest.replace(/^https:\/\//, "");

    const shop = await prisma.shop.findUnique({ where: { shopDomain } });
    if (!shop || !shop.installed) {
      return res.status(401).json({ error: "Unauthorized: shop not installed" });
    }

    // Authoritative shop for this request — routes should use this, not
    // req.query.shop, which is caller-supplied and unverified.
    req.shopifyShop = shop;
    next();
  } catch (err) {
    console.error("❌ verifyShopifyAuth error:", err.message);
    res.status(401).json({ error: "Unauthorized" });
  }
}
