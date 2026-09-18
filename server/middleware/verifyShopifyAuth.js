

// ~/procircle/server/middleware/verifyShopifyAuth.js
//
// Verifies the App Bridge session token sent as:
// Authorization: Bearer <JWT>
//
// With Shopify-managed installation, a newly installed shop may not yet
// have an offline Admin API access token in ProCircle's database.
//
// On the first authenticated request from the embedded app, this middleware
// exchanges the verified App Bridge ID token for an offline access token
// and stores the resulting installation state in Postgres.

import { shopify } from "../shopify.js";
import prisma from "../prismaClient.js";
import {
  exchangeIdTokenForOfflineToken,
  ensureFreshOfflineAccessToken,
  ensureShopifyShopId,
} from "../services/shopifyTokenService.js";

export default async function verifyShopifyAuth(req, res, next) {
  try {
    // -------------------------------------------------------
    // 1. Extract App Bridge ID token
    // -------------------------------------------------------
    const authHeader = req.headers.authorization || "";
    const match = authHeader.match(/^Bearer (.+)$/);

    if (!match) {
      return res.status(401).json({
        error: "Unauthorized: missing session token",
      });
    }

    const idToken = match[1];

    // -------------------------------------------------------
    // 2. Verify Shopify's signed session token
    // -------------------------------------------------------
    const payload = await shopify.session.decodeSessionToken(idToken);

    if (!payload?.dest) {
      return res.status(401).json({
        error: "Unauthorized: invalid session token",
      });
    }

    // The authenticated shop comes from the verified token.
    // Do NOT trust req.query.shop for authentication.
    const shopDomain = payload.dest.replace(/^https:\/\//, "");

    // -------------------------------------------------------
    // 3. Look up existing ProCircle installation
    // -------------------------------------------------------
    let shop = await prisma.shop.findUnique({
      where: { shopDomain },
    });

    // -------------------------------------------------------
    // 4. Bootstrap Shopify-managed installation
    // -------------------------------------------------------
    //
    // A valid App Bridge ID token proves that this request came
    // from the Shopify Admin for this app/shop.
    //
    // If ProCircle doesn't yet have its offline token, exchange
    // the ID token for one and create/update the Shop record.
    //
    if (!shop || !shop.installed || !shop.accessToken) {
      console.log(
        `🔑 No offline access token for ${shopDomain}; starting Shopify token exchange`
      );

      shop = await exchangeIdTokenForOfflineToken(
        shopDomain,
        idToken
      );

      console.log(
        `✅ Shopify offline access token stored for ${shopDomain}`
      );
    }

    // If this shop uses an expiring offline token, make sure it
      // remains valid before allowing the request to continue.
      shop = await ensureFreshOfflineAccessToken(shop);
      shop = await ensureShopifyShopId(shop);

    // -------------------------------------------------------
    // 5. Make authenticated Shop available to API routes
    // -------------------------------------------------------
    req.shopifyShop = shop;

    return next();

  } catch (err) {
    console.error(
      "❌ verifyShopifyAuth error:",
      err?.message || err
    );

    // Log Shopify's response server-side if token exchange failed,
    // without exposing it to the browser.
    if (err?.shopifyResponse) {
      console.error(
        "❌ Shopify token exchange response:",
        err.shopifyResponse
      );
    }

    return res.status(401).json({
      error: "Unauthorized",
    });
  }
}
