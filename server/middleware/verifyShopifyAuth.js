// ~/procircle/server/middleware/verifyShopifyAuth.js
import { shopifyApi } from "@shopify/shopify-api";
import dotenv from "dotenv";

dotenv.config();

const shopify = shopifyApi({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET,
  scopes: process.env.SHOPIFY_SCOPES.split(","),
  hostName: process.env.APP_URL.replace(/https?:\/\//, ""),
  apiVersion: process.env.SHOPIFY_API_VERSION || "2025-10",
  isEmbeddedApp: true,
});

export default async function verifyShopifyAuth(req, res, next) {
  try {
    const sessionId = await shopify.session.getCurrentId({
      isOnline: false,
      rawRequest: req,
      rawResponse: res,
    });

    if (!sessionId) {
      return res.status(401).json({ error: "Unauthorized: No session found" });
    }

    const session = await shopify.sessionStorage.loadSession(sessionId);
    if (!session || !session.accessToken) {
      return res.status(401).json({ error: "Unauthorized: Invalid session" });
    }

    req.shopifySession = session;
    next();
  } catch (err) {
    console.error("❌ verifyShopifyAuth error:", err);
    res.status(401).json({ error: "Unauthorized" });
  }
}