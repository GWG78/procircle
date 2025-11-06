// server/webhooks/appUninstalled.mjs
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

export default async function appUninstalledHandler(topic, shop, body) {
  console.log(`🧹 App uninstalled for shop: ${shop}`);

  try {
    await prisma.shop.update({
      where: { shopDomain: shop },
      data: {
        installed: false,
        uninstalledAt: new Date(),
        accessToken: null,
        updatedAt: new Date(),
      },
    });

    console.log(`✅ Marked ${shop} as uninstalled`);
  } catch (error) {
    console.error(`❌ Failed to mark ${shop} as uninstalled:`, error);
  } finally {
    // Always close Prisma connections in background jobs / webhooks
    await prisma.$disconnect();
  }
}