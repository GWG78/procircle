import { shopifyApi } from "@shopify/shopify-api";


export const shopify = shopifyApi({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET,
  scopes: process.env.SHOPIFY_SCOPES.split(","),
  hostName: process.env.APP_URL.replace(/https?:\/\//, ""),
  //apiVersion: process.env.SHOPIFY_API_VERSION || "2024-07",
  apiVersion: "2023-10",
  isEmbeddedApp: true,
});