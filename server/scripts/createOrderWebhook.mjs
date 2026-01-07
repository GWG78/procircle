import dotenv from "dotenv";
dotenv.config();

import fetch from "node-fetch";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function run() {
  const shop = "6b18d3-3.myshopify.com"; 

  const shopRecord = await prisma.shop.findUnique({
    where: { shopDomain: shop },
  });

  if (!shopRecord) {
    throw new Error(`Shop not found in DB: ${shop}`);
  }

  const accessToken = shopRecord.accessToken;

  const webhookUrl =
    "https://procircle-server.onrender.com/api/webhooks/orders-create";

  const res = await fetch(
    `https://${shop}/admin/api/2024-01/webhooks.json`,
    {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": accessToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        webhook: {
          topic: "orders/create",
          address: webhookUrl,
          format: "json",
        },
      }),
    }
  );

  const data = await res.json();

  if (!res.ok) {
    console.error("❌ Failed to create webhook:", data);
    process.exit(1);
  }

  console.log("✅ Webhook created successfully!");
  console.log(data);
}

run()
  .catch((err) => {
    console.error(err);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });