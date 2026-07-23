import express from "express";
import crypto from "crypto";
import { PrismaClient } from "@prisma/client";
import appUninstalledHandler from "../webhooks/appUninstalled.mjs";
import discountDeletedHandler from "../webhooks/discountDeleted.mjs";
import { shopifyApi, DeliveryMethod } from "@shopify/shopify-api";
import { triggerOrderSync } from "../services/makeWebhookService.js";

const prisma = new PrismaClient();
const router = express.Router();

/**
 * ✅ Capture raw body specifically for Shopify webhook
 * Note: Must come *before* express.json()
 */
router.post(
  "/orders-create",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    try {
      const hmacHeader = req.get("X-Shopify-Hmac-Sha256");
      const secret = process.env.SHOPIFY_API_SECRET;
      const rawBody = req.body; // raw buffer from express.raw()

      // 🧩 Debug — show what we’re verifying
      if (!Buffer.isBuffer(rawBody)) {
        console.error("❌ Expected raw buffer, got:", typeof rawBody);
        return res.status(400).send("Invalid raw body type");
      }

      const generatedHmac = crypto
        .createHmac("sha256", secret)
        .update(rawBody)
        .digest("base64");

      console.log("🔐 Shopify HMAC Header:", hmacHeader);
      console.log("🔑 Our Generated HMAC:", generatedHmac);
      console.log("🧩 Secret Key Used:", secret.slice(0, 14) + "...");

      if (generatedHmac !== hmacHeader) {
        console.error("❌ Webhook verification failed — invalid signature");
        return res.status(401).send("Unauthorized");
      }

      console.log("✅ Webhook verified successfully!");
      const body = JSON.parse(rawBody.toString("utf8"));
      const order = body;
      const code = order.discount_codes?.[0]?.code;

      if (!code) {
        console.log("⚪ Order has no discount code, skipping.");
        return res.status(200).send("No discount code.");
      }

      if (!code.startsWith("PROCIRCLE-")) {
        console.log(`⚪ Discount code ${code} is not a ProCircle code, skipping.`);
        return res.status(200).send("Not a ProCircle discount code.");
      }

      console.log(`📦 New order received with ProCircle discount code: ${code}`);

      const campaign = await prisma.campaign.findFirst({
        where: { discountCode: code },
        include: { shop: true },
      });

      if (!campaign) {
        console.log(`⚠️ No Campaign found for discount code ${code}.`);
        return res.status(200).send("Unknown ProCircle discount code.");
      }

      const redemption = await prisma.redemption.findFirst({
        where: {
          campaignId: campaign.id,
          status: "confirmed",
          member: { email: order.email },
        },
      });

      if (!redemption) {
        // Member may have used the link without going through ProCircle
        // (e.g. shared code) — log for manual review, don't error.
        console.log(
          `⚠️ No confirmed Redemption found for campaign ${campaign.id} and email ${order.email}. Flagging for review.`
        );
        return res.status(200).send("No matching redemption found.");
      }

      const orderAmount = parseFloat(order.total_price);
      const orderCompletedAt = new Date(order.created_at);

      await prisma.redemption.update({
        where: { id: redemption.id },
        data: {
          shopifyOrderId: order.id.toString(),
          orderAmount,
          orderCompletedAt,
        },
      });

      console.log(`✅ Order for ${code} synced to Redemption ${redemption.id}.`);

      try {
        await triggerOrderSync({
          memberEmail: order.email,
          campaignName: campaign.name,
          brandName: campaign.shop.shopDomain,
          shopifyOrderId: order.id.toString(),
          orderAmount,
          orderCompletedAt,
        });
      } catch (syncErr) {
        console.error("❌ Make.com order sync failed:", syncErr);
      }

      res.status(200).send("Webhook processed successfully.");
    } catch (err) {
      console.error("❌ Error handling order webhook:", err);
      res.status(500).send("Webhook failed.");
    }
  }
);

/**
 * 🧹 Handle APP_UNINSTALLED webhook
 */
router.post(
  "/app-uninstalled",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    try {
      const hmacHeader = req.get("X-Shopify-Hmac-Sha256");
      const secret = process.env.SHOPIFY_API_SECRET;
      const rawBody = req.body;

      if (!Buffer.isBuffer(rawBody)) {
        console.error("❌ Expected raw buffer, got:", typeof rawBody);
        return res.status(400).send("Invalid raw body type");
      }

      // ✅ Verify webhook authenticity
      const generatedHmac = crypto
        .createHmac("sha256", secret)
        .update(rawBody)
        .digest("base64");

      if (generatedHmac !== hmacHeader) {
        console.error("❌ Webhook verification failed — invalid signature");
        return res.status(401).send("Unauthorized");
      }

      console.log("✅ App Uninstalled Webhook verified!");
      const body = JSON.parse(rawBody.toString("utf8"));
      const shopDomain = body.myshopify_domain || body.domain || req.get("X-Shopify-Shop-Domain");

      console.log(`🧹 App uninstalled for shop: ${shopDomain}`);

      // ✅ Run the handler logic (from appUninstalled.mjs)
      await appUninstalledHandler("APP_UNINSTALLED", shopDomain, body);

      res.status(200).send("Uninstall processed.");
    } catch (err) {
      console.error("❌ Error handling app uninstall webhook:", err);
      res.status(500).send("Webhook failed.");
    }
  }
);

/**
 * 🗑️ Handle DISCOUNTS_DELETE webhook (discounts/delete)
 */
router.post(
  "/discounts-delete",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    try {
      const hmacHeader = req.get("X-Shopify-Hmac-Sha256");
      const secret = process.env.SHOPIFY_API_SECRET;
      const rawBody = req.body;

      if (!Buffer.isBuffer(rawBody)) {
        console.error("❌ Expected raw buffer, got:", typeof rawBody);
        return res.status(400).send("Invalid raw body type");
      }

      const generatedHmac = crypto
        .createHmac("sha256", secret)
        .update(rawBody)
        .digest("base64");

      if (generatedHmac !== hmacHeader) {
        console.error("❌ Webhook verification failed — invalid signature");
        return res.status(401).send("Unauthorized");
      }

      console.log("✅ Discount Deleted Webhook verified!");
      const body = JSON.parse(rawBody.toString("utf8"));
      const shopDomain = req.get("X-Shopify-Shop-Domain");

      await discountDeletedHandler("DISCOUNTS_DELETE", shopDomain, body);

      res.status(200).send("Discount deletion processed.");
    } catch (err) {
      console.error("❌ Error handling discount deleted webhook:", err);
      res.status(500).send("Webhook failed.");
    }
  }
);

export default router;