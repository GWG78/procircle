import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  console.log("🌱 Seeding ProCircle database...");

  const shopDomain = "demo-shop.myshopify.com";

  // 1️⃣ Create or find shop
  let shop = await prisma.shop.findUnique({ where: { shopDomain } });

  if (!shop) {
    shop = await prisma.shop.create({
      data: {
        shopDomain,
        accessToken: "shpat_test_token_12345",
        scope: "read_products,write_discounts,read_orders",
        installed: true,
      },
    });
    console.log(`✅ Created shop: ${shop.shopDomain}`);
  } else {
    console.log(`ℹ️ Shop already exists: ${shop.shopDomain}`);
  }

  // 2️⃣ Create default settings if none exist
  let settings = await prisma.shopSettings.findUnique({
    where: { shopId: shop.id },
  });

  if (!settings) {
    // TODO: migrate to Campaign/Redemption model — discountType/discountValue/
    // expiryDays/maxDiscounts were removed from ShopSettings (now campaign-level).
    settings = await prisma.shopSettings.create({
      data: {
        shopId: shop.id,
      },
    });
    console.log(`✅ Created default settings for ${shop.shopDomain}`);
  } else {
    console.log(`ℹ️ Settings already exist for ${shop.shopDomain}`);
  }

  // TODO: migrate to Campaign/Redemption model — Discount model was dropped.
  // Seed a demo Campaign (+ optional Redemption) here instead.
  // const existingDiscount = await prisma.discount.findFirst({
  //   where: { shopId: shop.id },
  // });
  //
  // if (!existingDiscount) {
  //   const expiryDate = new Date();
  //   expiryDate.setDate(expiryDate.getDate() + (settings.expiryDays || 30));
  //
  //   const discount = await prisma.discount.create({
  //     data: {
  //       shopId: shop.id,
  //       code: "PRC-DEMO-10",
  //       amount: settings.discountValue,
  //       type: settings.discountType,
  //       expiresAt: expiryDate,
  //     },
  //   });
  //   console.log(`✅ Created discount: ${discount.code}`);
  // } else {
  //   console.log(`ℹ️ Discount already exists: ${existingDiscount.code}`);
  // }

  console.log("🎉 Seeding complete!");
}

main()
  .catch((e) => {
    console.error("❌ Error during seeding:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });