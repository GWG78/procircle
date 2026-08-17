// server/webhooks/shopRedact.mjs
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

export default async function shopRedactHandler(topic, shop, body) {
  const shopDomain = shop || body?.shop_domain || body?.domain;

  console.log(`🗑️ Shop redact request for: ${shopDomain}`);

  try {
    const shopRecord = await prisma.shop.findUnique({ where: { shopDomain } });

    if (!shopRecord) {
      console.log(`⚪ No Shop record found for ${shopDomain}. Nothing to redact.`);
      return;
    }

    const campaigns = await prisma.campaign.findMany({
      where: { shopId: shopRecord.id },
      select: { id: true },
    });
    const campaignIds = campaigns.map((c) => c.id);

    // None of these relations cascade (see prisma/schema.prisma), so child
    // rows must be deleted before their parents: Redemption/CampaignFilter
    // before Campaign, everything before Shop. Wrapped in a transaction so
    // a failure partway through doesn't leave orphaned rows.
    await prisma.$transaction(async (tx) => {
      if (campaignIds.length > 0) {
        await tx.redemption.deleteMany({ where: { campaignId: { in: campaignIds } } });
        await tx.campaignFilter.deleteMany({ where: { campaignId: { in: campaignIds } } });
        await tx.campaign.deleteMany({ where: { shopId: shopRecord.id } });
      }

      await tx.memberShopifyLink.deleteMany({ where: { shopId: shopRecord.id } });
      await tx.shopSettings.deleteMany({ where: { shopId: shopRecord.id } });

      // The Shop row itself is kept (matching how app/uninstalled already
      // preserves it) rather than deleted — shopDomain is a store
      // identifier, not personal data, and there's no owner name/email
      // field on this model to redact. accessToken is already null from
      // the uninstall handler that fires well before this (shop/redact
      // arrives 48 days after uninstall); nulled again here defensively.
      await tx.shop.update({
        where: { id: shopRecord.id },
        data: {
          accessToken: null,
          name: null,
          displayNameOverride: null,
        },
      });
    });

    console.log(
      `✅ Redacted shop-scoped data for ${shopDomain} (${campaignIds.length} campaign(s) removed)`
    );
  } catch (error) {
    console.error(`❌ Failed to redact shop data for ${shopDomain}:`, error);
  }
}
