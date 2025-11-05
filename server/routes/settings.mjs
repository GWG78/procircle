import express from "express";
import prisma from "../prismaClient.js";
import verifyShopifyAuth from "../middleware/verifyShopifyAuth.js";

const router = express.Router();

// ✅ Get settings
router.get("/", verifyShopifyAuth, async (req, res) => {
  try {
    const shopDomain = req.shop;
    const shop = await prisma.shop.findUnique({
      where: { shopDomain },
      include: { settings: true },
    });
    res.json(shop.settings || {});
  } catch (err) {
    console.error("❌ Error fetching settings:", err);
    res.status(500).json({ error: "Failed to load settings" });
  }
});

// ✅ Save settings
router.post("/", verifyShopifyAuth, async (req, res) => {
  try {
    const shopDomain = req.shop;
    const shop = await prisma.shop.findUnique({ where: { shopDomain } });
    if (!shop) return res.status(404).json({ error: "Shop not found" });

    const { discountType, discountValue, expiryDays, maxDiscounts, appliesTo } = req.body;

    const updated = await prisma.shopSettings.upsert({
      where: { shopId: shop.id },
      update: { discountType, discountValue, expiryDays, maxDiscounts, appliesTo },
      create: { shopId: shop.id, discountType, discountValue, expiryDays, maxDiscounts, appliesTo },
    });

    res.json(updated);
  } catch (err) {
    console.error("❌ Error saving settings:", err);
    res.status(500).json({ error: "Failed to save settings" });
  }
});

export default router;