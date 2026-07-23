// server/scripts/dailyExpiryJob.mjs
//
// Run daily by Render's cron service. Standalone process — initialises its
// own Prisma client and disconnects when done.

import { PrismaClient } from "@prisma/client";
import { triggerExpiryReminder, triggerExpiryNotification } from "../services/makeWebhookService.js";
import { removeCustomerFromCampaignDiscount } from "../services/shopifyCustomerService.js";

const prisma = new PrismaClient();

async function run() {
  console.log(`[dailyExpiryJob] Starting at ${new Date().toISOString()}`);

  const now = new Date();
  const in48Hours = new Date(now.getTime() + 48 * 60 * 60 * 1000);

  try {
    // --- STEP A: Send 48hr reminders ---
    const reminders = await prisma.redemption.findMany({
      where: {
        status: "confirmed",
        shopifyOrderId: null,
        reminderSentAt: null,
        accessExpiresAt: { gte: now, lte: in48Hours },
      },
      include: {
        member: true,
        campaign: { include: { shop: true } },
      },
    });

    console.log(`[dailyExpiryJob] ${reminders.length} reminder(s) to send`);

    for (const redemption of reminders) {
      try {
        const sent = await triggerExpiryReminder({
          memberEmail: redemption.member.email,
          campaignName: redemption.campaign.name,
          brandName: redemption.campaign.shop.shopDomain,
          accessExpiresAt: redemption.accessExpiresAt,
          discountLink: redemption.campaign.discountLink,
        });

        if (!sent) {
          // triggerExpiryReminder never throws — it already logged its own
          // [ALERT] line. Leave reminderSentAt unset so this redemption is
          // still eligible for tomorrow's reminder query and gets retried,
          // rather than being marked as sent when it wasn't.
          console.log(`[dailyExpiryJob] Reminder NOT sent for redemption ${redemption.id} — will retry on next run`);
          continue;
        }

        await prisma.redemption.update({
          where: { id: redemption.id },
          data: { reminderSentAt: now },
        });

        console.log(`[dailyExpiryJob] Reminder sent for redemption ${redemption.id}`);
      } catch (err) {
        console.error(`[dailyExpiryJob] Reminder failed for redemption ${redemption.id}:`, err.message);
        // Continue — don't let one failure stop the rest
      }
    }

    // --- STEP B: Remove expired members ---
    const expired = await prisma.redemption.findMany({
      where: {
        status: "confirmed",
        shopifyOrderId: null,
        accessExpiresAt: { lt: now },
      },
      include: {
        member: { include: { shopifyLinks: true } },
        campaign: { include: { shop: true } },
      },
    });

    console.log(`[dailyExpiryJob] ${expired.length} expired redemption(s) to process`);

    for (const redemption of expired) {
      try {
        const link = redemption.member.shopifyLinks.find(
          (l) => l.shopId === redemption.campaign.shopId
        );

        if (link) {
          await removeCustomerFromCampaignDiscount(
            redemption.campaign.shop,
            redemption.campaign,
            link.shopifyCustomerId
          );
        } else {
          console.warn(
            `[dailyExpiryJob] No Shopify link found for member ${redemption.memberId} on shop ${redemption.campaign.shopId}`
          );
        }

        await prisma.redemption.update({
          where: { id: redemption.id },
          data: { status: "expired" },
        });

        await triggerExpiryNotification({
          memberEmail: redemption.member.email,
          campaignName: redemption.campaign.name,
          brandName: redemption.campaign.shop.shopDomain,
        });

        console.log(`[dailyExpiryJob] Processed expiry for redemption ${redemption.id}`);
      } catch (err) {
        console.error(`[dailyExpiryJob] Expiry processing failed for redemption ${redemption.id}:`, err.message);
        // Continue — don't let one failure stop the rest. This redemption
        // still matches tomorrow's query (status unchanged), so it retries.
      }
    }
  } finally {
    await prisma.$disconnect();
    console.log(`[dailyExpiryJob] Done at ${new Date().toISOString()}`);
  }
}

run().catch((err) => {
  console.error("[dailyExpiryJob] Fatal error:", err);
  prisma.$disconnect();
  process.exit(1);
});
