// server/webhooks/ordersPaid.mjs

import { PrismaClient } from "@prisma/client";
import { postUsageRecord } from "../services/usageRecord.js";
import { fetchActiveSubscription } from "../services/partnerApi.js";
import { convertCurrency } from "../services/currencyService.js";

const prisma = new PrismaClient();

const COMMISSION_METER_HANDLE = "procircle-commish";
const SHOPIFY_BILLING_CURRENCY = "USD";

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

    /*
     * Use Shopify's shop-money subtotal as the commission basis.
     * This represents the order in the merchant's shop currency.
     */
    const shopMoney =
      body.subtotal_price_set?.shop_money;

    const orderAmount = parseFloat(
      shopMoney?.amount ??
        body.subtotal_price ??
        body.total_price ??
        0
    );

    const orderCurrency = String(
      shopMoney?.currency_code ??
        body.currency ??
        ""
    ).toUpperCase();

    if (
      !Number.isFinite(orderAmount) ||
      orderAmount <= 0 ||
      !orderCurrency
    ) {
      console.error(
        `❌ Invalid order amount/currency for order ${body.id}`
      );
      return;
    }

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
     * Finding an existing redemption does not necessarily mean billing
     * is complete. A previous attempt may have persisted the order and
     * commission but failed before Shopify accepted the usage event.
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

    /*
     * Once calculated, the stored commission amount and currency are
     * authoritative for retries.
     */
    const commissionAmount =
      redemption.commissionAmount ??
      Number(
        (orderAmount * commissionRate).toFixed(2)
      );

    const commissionCurrency =
      redemption.commissionCurrency ??
      orderCurrency;

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
     * Calculate the Shopify billing amount only once.
     *
     * Shopify App Pricing is currently denominated in USD. The original
     * commission remains stored in the merchant's order currency.
     *
     * If this webhook is retried, reuse the stored USD amount and FX
     * rate rather than fetching a new exchange rate.
     */
    let shopifyBillingAmount =
      redemption.shopifyBillingAmount;

    let shopifyExchangeRate =
      redemption.shopifyExchangeRate;

    let shopifyExchangeRateAt =
      redemption.shopifyExchangeRateAt;

    if (shopifyBillingAmount == null) {
      const conversion = await convertCurrency(
        commissionAmount,
        commissionCurrency,
        SHOPIFY_BILLING_CURRENCY
      );

      shopifyBillingAmount =
        conversion.convertedAmount;

      shopifyExchangeRate =
        conversion.rate;

      shopifyExchangeRateAt =
        new Date(conversion.rateTimestamp);
    }

    if (
      !Number.isFinite(shopifyBillingAmount) ||
      shopifyBillingAmount <= 0
    ) {
      console.error(
        `❌ Invalid Shopify billing amount for order ${shopifyOrderId}`
      );
      return;
    }

    /*
     * Persist all financial values BEFORE contacting Shopify billing.
     * This makes retries deterministic and preserves the exact FX rate
     * used to calculate the merchant charge.
     */
    redemption = await prisma.redemption.update({
      where: { id: redemption.id },
      data: {
        shopifyOrderId,
        orderAmount,
        orderCurrency,
        orderCompletedAt: new Date(
          body.created_at || Date.now()
        ),

        commissionAmount,
        commissionCurrency,

        shopifyBillingAmount,
        shopifyBillingCurrency:
          SHOPIFY_BILLING_CURRENCY,
        shopifyExchangeRate,
        shopifyExchangeRateAt,

        commissionEventKey,
      },
    });

    console.log(
      `✅ Redemption ${redemption.id} linked to order ${shopifyOrderId}; ` +
        `commission pending: ${commissionAmount.toFixed(2)} ${commissionCurrency} ` +
        `→ ${shopifyBillingAmount.toFixed(2)} ${SHOPIFY_BILLING_CURRENCY}`
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
     * The Shopify meter is priced at USD 1 per unit, so the quantity
     * submitted here is the stored USD billing amount.
     *
     * postUsageRecord uses the deterministic idempotency key:
     * procircle-commish-{shopifyOrderId}
     */
    const usageResult = await postUsageRecord(
      shopRecord.shopifyShopId,
      shopifyBillingAmount,
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
      `💰 ProCircle commission reported for order ${shopifyOrderId}: ` +
        `${commissionAmount.toFixed(2)} ${commissionCurrency} ` +
        `→ ${shopifyBillingAmount.toFixed(2)} ${SHOPIFY_BILLING_CURRENCY}`
    );
  } catch (err) {
    console.error(
      `❌ ordersPaid handler error for shop ${shop}:`,
      err
    );
  }
}
