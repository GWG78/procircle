import express from "express";
import { PrismaClient } from "@prisma/client";
import { shopifyApi } from "@shopify/shopify-api";
import { generateDiscountCode } from "../utils/generateCode.js";

const prisma = new PrismaClient();
const router = express.Router();

// ✅ Middleware — basic API key check (Google Sheets → App)
router.use((req, res, next) => {
  const token = req.headers["x-api-key"];
  if (token !== process.env.GOOGLE_SHEET_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
});

// ✅ Shopify API setup (minimal local instance)
const shopify = shopifyApi({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET,
  scopes: process.env.SHOPIFY_SCOPES.split(","),
  hostName: process.env.APP_URL.replace(/https?:\/\//, ""),
  apiVersion: process.env.SHOPIFY_API_VERSION || "2024-07",
  isEmbeddedApp: true,
});

// ✅ POST /api/discounts
router.post("/create", async (req, res) => {
  try {
    const { shopDomain, name, amount, type, expiry } = req.body;

    if (!shopDomain || !name) {
      return res.status(400).json({ error: "Missing shopDomain or name" });
    }

    // 🏪 1️⃣ Get shop & settings
    const shop = await prisma.shop.findUnique({
      where: { shopDomain },
      include: { settings: true },
    });

    if (!shop) {
      return res.status(404).json({ error: "Shop not found" });
    }

    // ⚙️ 2️⃣ Load defaults from ShopSettings
    const settings = shop.settings || {};
    const discountType = type || settings.discountType || "percentage";
    const discountValue =
      amount ?? settings.discountValue ?? 10; // prefer provided amount, else default
    const expiryDays = settings.expiryDays ?? 30;

    // Compute expiry date
    const expiryDate = expiry
      ? new Date(expiry)
      : new Date(Date.now() + expiryDays * 24 * 60 * 60 * 1000);

    // 🏷️ Generate discount code
    const code = generateDiscountCode(name);
    console.log(
      `🚀 Creating discount for ${shopDomain} → ${code} (${discountValue}${discountType === "percentage" ? "%" : " fixed"})`
    );

    // 🧠 Shopify REST client
    const client = new shopify.clients.Rest({
      session: {
        shop: shop.shopDomain,
        accessToken: shop.accessToken,
      },
    });

    // 🛍️ Create price rule
    const priceRuleResponse = await client.post({
      path: "price_rules",
      data: {
        price_rule: {
          title: `ProCircle-${code}`,
          target_type: "line_item",
          target_selection: "all",
          allocation_method: "across",
          value_type: discountType === "percentage" ? "percentage" : "fixed_amount",
          value: discountType === "percentage"
            ? `-${discountValue}`
            : `-${discountValue}`,
          once_per_customer: true,
          usage_limit: 1,
          customer_selection: "all",
          starts_at: new Date().toISOString(),
          ends_at: expiryDate.toISOString(),
        },
      },
      type: "application/json",
    });

    const priceRuleId = priceRuleResponse.body.price_rule.id;

    // 🧾 Create discount code
    const discountResponse = await client.post({
      path: `price_rules/${priceRuleId}/discount_codes`,
      data: { discount_code: { code } },
      type: "application/json",
    });

    // 💾 Save discount locally
    const discount = await prisma.discount.create({
      data: {
        shopId: shop.id,
        code,
        amount: parseFloat(discountValue),
        type: discountType,
        expiresAt: expiryDate,
      },
    });

    console.log(`✅ Discount created and saved: ${code}`);
    res.json({ success: true, discount });
  } catch (error) {
    console.error("❌ Error creating discount:", error);
    res.status(500).json({
      error: "Failed to create discount",
      details: error.message,
    });
  }
});

export default router;