import { shopifyApi } from "@shopify/shopify-api";

// Fail loudly and specifically at startup rather than falling back to any
// hardcoded value — previously an unset APP_URL would still crash, but via
// an opaque "Cannot read properties of undefined" from .replace() with no
// indication which variable was the problem.
for (const key of ["SHOPIFY_API_KEY", "SHOPIFY_API_SECRET", "APP_URL"]) {
  if (!process.env[key]) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
}

export const shopify = shopifyApi({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET,
  scopes: process.env.SHOPIFY_SCOPES.split(","),
  hostName: process.env.APP_URL.replace(/https?:\/\//, ""),
  apiVersion: process.env.SHOPIFY_API_VERSION,
  isEmbeddedApp: true,
});