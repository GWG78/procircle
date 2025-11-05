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

    const shop = await prisma.shop.findUnique({ where: { shopDomain } });
    if (!shop) {
      return res.status(404).json({ error: "Shop not found" });
    }

    // Generate a new discount code like PRC-GG-2F8C
    const code = generateDiscountCode(name);

    console.log(`🚀 Creating discount in Shopify for ${shopDomain} → ${code}`);

    // Shopify REST API client
    const client = new shopify.clients.Rest({
      session: {
        shop: shop.shopDomain,
        accessToken: shop.accessToken,
      },
    });


    // 🧠 Ensure amount is a valid decimal or fallback to 10
            let discountValue = 10.0; // default fallback

            if (amount !== undefined && amount !== null && amount !== "") {
            const parsed = parseFloat(amount);
            if (!isNaN(parsed)) discountValue = parsed;
            else console.warn(`⚠️ Amount '${amount}' could not be parsed, using fallback: ${discountValue}`);
            } else {
            console.warn("⚠️ No amount provided, using default 10%");
            }

    // ✅ Create price rule + discount code in Shopify
    const priceRuleResponse = await client.post({
      path: "price_rules",
      data: {
        price_rule: {
          title: `ProCircle-${code}`,
          target_type: "line_item",
          target_selection: "all",
          allocation_method: "across",
          value_type: type === "percentage" ? "percentage" : "fixed_amount",
          value: type === "percentage" ? `-${discountValue}` : `-${discountValue}`,
          once_per_customer: true,
          usage_limit: 1,
          customer_selection: "all",
          starts_at: new Date().toISOString(),
          ends_at: expiry ? new Date(expiry).toISOString() : null,
        },
      },
      type: "application/json",
    });

    const priceRuleId = priceRuleResponse.body.price_rule.id;

    // Create the actual discount code under that rule
    const discountResponse = await client.post({
      path: `price_rules/${priceRuleId}/discount_codes`,
      data: {
        discount_code: { code },
      },
      type: "application/json",
    });

    // ✅ Store in your local database
    const discount = await prisma.discount.create({
      data: {
        shopId: shop.id,
        code,
        amount: parseFloat(amount),
        type,
        expiresAt: expiry ? new Date(expiry) : null,
      },
    });

    console.log(`✅ Discount created: ${code}`);
    res.json({ success: true, discount });

  } catch (error) {
    console.error("❌ Error creating discount:", error);
    res.status(500).json({ error: "Failed to create discount", details: error.message });
  }
});

export default router;