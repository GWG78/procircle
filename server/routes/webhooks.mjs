import express from "express";
import crypto from "crypto";
import { PrismaClient } from "@prisma/client";

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
      res.status(200).send("Webhook processed successfully.");
    } catch (err) {
      console.error("❌ Error handling order webhook:", err);
      res.status(500).send("Webhook failed.");
    }
  }
);

export default router;