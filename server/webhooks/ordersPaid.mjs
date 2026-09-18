// server/webhooks/ordersPaid.mjs

import { PrismaClient } from "@prisma/client";
import { postUsageRecord } from "../services/usageRecord.js";
import { fetchActiveSubscription } from "../services/partnerApi.js";

const prisma = new PrismaClient();

const COMMISSION_METER_HANDLE = "procircle-commish";

export default async function ordersPaidHandler(topic, shop, body) {
  try {
    console.log(
      `💰 Order paid for shop: ${shop}, order: ${body.id}`
    );

    const discountCodes = body.discount_codes || [];

    if (discountCodes.length === 0) {
      console.log(
        `⚪ No discount codes on order ${body.id} — skipping`
      );
      return;
    }

    const discountCode = discountCodes[0].code;

    if (!discountCode?.startsWith("PROCIRCLE-")) {
      console.log(
        `⚪ Discount code ${discountCode} is not a ProCircle code — skipping`
      );
      return;
    }

    const orderAmount = parseFloat(
      body.subtotal_price ?? body.total_price ?? 0
    );

    const shopifyOrderId = String(body.id);
    const commissionEventKey =
      `procircle-commish-${shopifyOrderId}`;

    const shopRecord = await prisma.shop.findUnique({
      where: { shopDomain: shop },
    });

    if (!shopRecord) {
      console.error(`❌ No shop record found for ${shop}`);
      return;
    }

    if (!shopRecord.shopifyShopId) {
      console.error(
        `❌ No Shopify Shop ID stored for ${shop}`
      );
      return;
    }

    const campaign = await prisma.campaign.findFirst({
      where: {
        discountCode,
        shopId: shopRecord.id,
      },
    });

    if (!campaign) {
      console.log(
        `⚪ Discount code ${discountCode} is not a ProCircle campaign for ${shop} — skipping`
      );
      return;
    }

    /*
     * Has this order already been linked to a redemption?
     *
     * Unlike the old implementation, finding it does not automatically
     * mean billing is complete. A previous attempt may have linked the
     * order but failed before Shopify accepted the commission event.
     */
    let redemption = await prisma.redemption.findFirst({
      where: { shopifyOrderId },
    });

    if (redemption?.commissionReportedAt) {
      console.log(
        `⚪ Commission for order ${shopifyOrderId} already reported — skipping`
      );
      return;
    }

    if (!redemption) {
      redemption = await prisma.redemption.findFirst({
        where: {
          campaignId: campaign.id,
          status: "confirmed",
          member: {
            email: body.email,
          },
        },
      });

      if (!redemption) {
        console.log(
          `⚠️ No confirmed Redemption found for campaign ${campaign.id} and email ${body.email}. Flagging for review.`
        );
        return;
      }
    }

    const commissionRate =
      shopRecord.commissionRate ?? 0.08;

    const commissionAmount =
      redemption.commissionAmount ??
      parseFloat(
        (orderAmount * commissionRate).toFixed(2)
      );

    if (
      !Number.isFinite(commissionAmount) ||
      commissionAmount <= 0
    ) {
      console.log(
        `⚪ Commission amount is invalid or 0 for order ${shopifyOrderId} — skipping`
      );
      return;
    }

    /*
     * Persist the order and calculated commission BEFORE contacting
     * Shopify billing. If Shopify is temporarily unavailable, we retain
     * everything needed to retry the commission later.
     */
    redemption = await prisma.redemption.update({
      where: { id: redemption.id },
      data: {
        shopifyOrderId,
        orderAmount,
        orderCompletedAt: new Date(
          body.created_at || Date.now()
        ),
        commissionAmount,
        commissionEventKey,
      },
    });

    console.log(
      `✅ Redemption ${redemption.id} linked to order ${shopifyOrderId}; commission pending: ${commissionAmount.toFixed(2)}`
    );

    /*
     * App Pricing is the authoritative billing system for new
     * ProCircle installations.
     */
    const activeSubscription =
      await fetchActiveSubscription(
        shopRecord.shopifyShopId
      );

    if (!activeSubscription) {
      console.error(
        `❌ No active App Pricing subscription for ${shop}`
      );
      return;
    }

    const commissionMeter =
      activeSubscription.items?.find(
        (item) =>
          item.handle === COMMISSION_METER_HANDLE
      );

    if (!commissionMeter) {
      console.error(
        `❌ Active App Pricing subscription for ${shop} does not contain ${COMMISSION_METER_HANDLE}`
      );
      return;
    }

    /*
     * postUsageRecord uses a deterministic Shopify idempotency key:
     *
     * procircle-commish-{shopifyOrderId}
     *
     * Re-submitting the same order therefore cannot create a second
     * usage event.
     */
    const usageResult = await postUsageRecord(
      shopRecord.shopifyShopId,
      commissionAmount,
      shopifyOrderId
    );

    if (!usageResult) {
      console.error(
        `❌ Commission event was not accepted for order ${shopifyOrderId}; commission remains pending`
      );
      return;
    }

    await prisma.redemption.update({
      where: { id: redemption.id },
      data: {
        commissionReportedAt: new Date(),
      },
    });

    console.log(
      `💰 ProCircle commission reported for order ${shopifyOrderId}: ${commissionAmount.toFixed(2)}`
    );
  } catch (err) {
    console.error(
      `❌ ordersPaid handler error for shop ${shop}:`,
      err
    );
  }
}
