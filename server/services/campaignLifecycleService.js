// services/campaignLifecycleService.js
//
// Shared "end a campaign" logic used by both the manual End Campaign
// action (routes/campaigns.mjs POST /:id/end) and the discounts/delete
// webhook handler (webhooks/discountDeleted.mjs) — the two can race each
// other (a merchant clicks End at the same moment Shopify delivers the
// webhook for a discount they deleted directly), so the transition and
// the notification side effect both need to be idempotent under that race.

import { PrismaClient } from "@prisma/client";
import { triggerCampaignEnded } from "./makeWebhookService.js";

const prisma = new PrismaClient();

/**
 * Atomically transitions a campaign to "ended" if it isn't already, then
 * — only if this call is the one that actually performed the transition —
 * best-effort notifies claimed-but-not-redeemed members via
 * triggerCampaignEnded. The atomic conditional update (status must not
 * already be "ended") is what makes this safe to call from two racing
 * paths: whichever call's updateMany affects a row wins and sends
 * notifications; the loser sees count === 0 and skips them, so Make.com
 * never fires twice for the same campaign ending.
 *
 * @param {number} campaignId
 * @param {{ endedReason?: string, shopDomain: string }} options
 * @returns {Promise<{ wonRace: boolean, campaign: import("@prisma/client").Campaign | null }>}
 */
async function endCampaignAndNotify(campaignId, { endedReason, shopDomain }) {
  const { count } = await prisma.campaign.updateMany({
    where: { id: campaignId, status: { not: "ended" } },
    data: {
      status: "ended",
      endedAt: new Date(),
      ...(endedReason ? { endedReason } : {}),
    },
  });

  const campaign = await prisma.campaign.findUnique({ where: { id: campaignId } });

  if (count === 0) {
    return { wonRace: false, campaign };
  }

  const claimedMembers = await prisma.redemption.findMany({
    where: { campaignId, status: "confirmed", shopifyOrderId: null },
    include: { member: true },
  });

  for (const redemption of claimedMembers) {
    await triggerCampaignEnded({
      memberEmail: redemption.member.email,
      campaignName: campaign.name,
      brandName: shopDomain,
    });
  }

  return { wonRace: true, campaign };
}

export { endCampaignAndNotify };
