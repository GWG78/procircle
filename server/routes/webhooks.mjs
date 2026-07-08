import express from "express";
import crypto from "crypto";
import { PrismaClient } from "@prisma/client";
import appUninstalledHandler from "../webhooks/appUninstalled.mjs";
import { shopifyApi, DeliveryMethod } from "@shopify/shopify-api";

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

      console.log(`📦 New order received with discount code: ${code}`);

      // Update DB
      const discount = await prisma.discount.findUnique({ where: { code } });
      if (!discount) {
        console.log(`⚠️ Discount ${code} not found in DB.`);
        return res.status(200).send("Unknown discount code.");
      }

      await prisma.discount.update({
        where: { id: discount.id },
        data: {
          redeemedAt: new Date(order.created_at),
          orderId: order.id.toString(),
          orderAmount: parseFloat(order.total_price),
        },
      });

      console.log(`✅ Order for ${code} synced to DB.`);

      await fetch(
        "https://script.google.com/macros/s/AKfycbw2y1ZmtRX8XxnkW_P8GxAq3vw5MBSF67hwB6gWjNoXz6dgg0gJeiTPBx8M3L0uWnQc/exec",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            shop: order.shop_domain || "forwardoutdoor.co",
            orderId: order.id.toString(),
            discountCode: code,
            amount: order.total_price,
            createdAt: order.created_at,
          }),
        }
      );

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

export default router;