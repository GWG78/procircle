// server/webhooks/ordersPaid.mjs
import { PrismaClient } from "@prisma/client";
import { postUsageRecord } from "../services/usageRecord.js";

const prisma = new PrismaClient();

export default async function ordersPaidHandler(topic, shop, body) {
  try {
    console.log(`💰 Order paid for shop: ${shop}, order: ${body.id}`);

    const discountCodes = body.discount_codes || [];
    if (discountCodes.length === 0) {
      console.log(`⚪ No discount codes on order ${body.id} — skipping`);
      return;
    }

    const discountCode = discountCodes[0].code;
    if (!discountCode?.startsWith("PROCIRCLE-")) {
      console.log(`⚪ Discount code ${discountCode} is not a ProCircle code — skipping`);
      return;
    }

    const orderAmount = parseFloat(body.subtotal_price ?? body.total_price ?? 0);
    const shopifyOrderId = String(body.id);

    const shopRecord = await prisma.shop.findUnique({ where: { shopDomain: shop } });
    if (!shopRecord) {
      console.error(`❌ No shop record found for ${shop}`);
      return;
    }

    // Same lookup as the /orders-create route in routes/webhooks.mjs —
    // there's no separate Discount model, discount codes live directly on
    // Campaign. Scoped to this shop's id (unlike /orders-create, which
    // doesn't scope by shop) since this drives a real financial charge.
    const campaign = await prisma.campaign.findFirst({
      where: { discountCode, shopId: shopRecord.id },
    });

    if (!campaign) {
      console.log(`⚪ Discount code ${discountCode} not a ProCircle campaign for ${shop} — skipping`);
      return;
    }

    // Idempotency guard — avoid double-charging if this webhook is
    // retried or delivered twice for the same order.
    const existingRedemption = await prisma.redemption.findFirst({
      where: { shopifyOrderId },
    });

    if (existingRedemption) {
      console.log(`⚪ Order ${shopifyOrderId} already processed — skipping`);
      return;
    }

    const redemption = await prisma.redemption.findFirst({
      where: {
        campaignId: campaign.id,
        status: "confirmed",
        member: { email: body.email },
      },
    });

    if (!redemption) {
      // Member may have used the link without going through ProCircle
      // (e.g. shared code) — log for manual review, don't error.
      console.log(
        `⚠️ No confirmed Redemption found for campaign ${campaign.id} and email ${body.email}. Flagging for review.`
      );
      return;
    }

    await prisma.redemption.update({
      where: { id: redemption.id },
      data: {
        shopifyOrderId,
        orderAmount,
        orderCompletedAt: new Date(body.created_at || Date.now()),
      },
    });

    console.log(`✅ Redemption ${redemption.id} linked to order ${shopifyOrderId} (€${orderAmount})`);

    const commissionRate = shopRecord.commissionRate ?? 0.08;
    const commissionAmount = parseFloat((orderAmount * commissionRate).toFixed(2));

    if (commissionAmount <= 0) {
      console.log(`⚪ Commission amount is 0 for order ${shopifyOrderId} — skipping usage record`);
      return;
    }

    if (!shopRecord.billingSubscriptionId) {
      console.warn(`⚠️ No billing subscription for shop ${shop} — commission not charged`);
      return;
    }

    await postUsageRecord(
      shop,
      shopRecord.accessToken,
      shopRecord.billingSubscriptionId,
      commissionAmount,
      shopifyOrderId
    );
  } catch (err) {
    console.error(`❌ ordersPaid handler error for shop ${shop}:`, err);
  }
}
