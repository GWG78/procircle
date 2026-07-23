// server/webhooks/discountDeleted.mjs
//
// Reacts to a merchant deleting a Shopify discount directly (bypassing the
// app) instead of only discovering it the next time some other action
// happens to touch that campaign. Fires for every discount deletion on the
// shop, including ones with no ProCircle campaign — that's expected, not
// an error.
import { PrismaClient } from "@prisma/client";
import { endCampaignAndNotify } from "../services/campaignLifecycleService.js";

const prisma = new PrismaClient();

export default async function discountDeletedHandler(topic, shop, body) {
  // Per Shopify's documented payload for this topic, the only fields are
  // admin_graphql_api_id and deleted_at — there's no numeric id to fall
  // back to (confirmed against shopify.dev, not assumed).
  const deletedGid = body.admin_graphql_api_id || null;

  if (!deletedGid) {
    console.warn(`⚠️ discounts/delete webhook for ${shop} had no usable discount id in payload:`, body);
    return;
  }

  const campaign = await prisma.campaign.findFirst({
    where: { shopifyDiscountId: deletedGid, shop: { shopDomain: shop } },
  });

  if (!campaign) {
    return;
  }

  console.log(
    `🗑️ Discount for campaign ${campaign.id} (${campaign.slug}) was deleted externally on ${shop} — ending campaign.`
  );

  const { wonRace } = await endCampaignAndNotify(campaign.id, {
    endedReason: "shopify_discount_deleted_externally",
    shopDomain: shop,
  });

  if (wonRace) {
    console.log(`✅ Campaign ${campaign.id} auto-ended (discount deleted externally).`);
  } else {
    console.log(`ℹ️ Campaign ${campaign.id} was already ended (raced with a manual End) — skipped duplicate notification.`);
  }
}
