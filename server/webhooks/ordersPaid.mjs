// server/webhooks/ordersPaid.mjs

import { PrismaClient } from "@prisma/client";
import { convertCurrency } from "../services/currencyService.js";
import { submitCommission } from "../services/commissionRetryService.js";
import { SystemicBillingError } from "../services/billingErrors.js";

const prisma = new PrismaClient();

const SHOPIFY_BILLING_CURRENCY = "USD";

export default async function ordersPaidHandler(topic, shop, body) {
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

  // No prefix check here: campaign codes are generated as PC-XXXX-<value>
  // (services/discountLinkService.js), and the old "PROCIRCLE-" prefix
  // check rejected every one of them. The campaign lookup below, by exact
  // code + shop, is the authoritative test of whether this is our code.
  if (!discountCode) {
    console.log(`⚪ Empty discount code on order ${body.id} — skipping`);
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
          // Member.email is stored lowercased (routes/members.mjs).
          email: String(body.email || "").trim().toLowerCase(),
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
   * Persist the order/commission fields BEFORE attempting FX
   * conversion. This is the critical write: once it succeeds, the
   * commission is discoverable by the retry job
   * (commissionAmount IS NOT NULL AND commissionReportedAt IS NULL)
   * even if every step after this one fails.
   *
   * Deliberately NOT caught here — if this write throws, it propagates
   * to the webhook route, which responds 500 so Shopify retries the
   * webhook. That's safe because the Redemption lookup above and
   * commissionEventKey are both deterministic from shopifyOrderId: a
   * replay of this same webhook recomputes the exact same values and
   * lands on the exact same row, so a retried delivery can't double-
   * persist or double-bill.
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

      commissionEventKey,
    },
  });

  console.log(
    `✅ Redemption ${redemption.id} linked to order ${shopifyOrderId}; ` +
      `commission pending: ${commissionAmount.toFixed(2)} ${commissionCurrency}`
  );

  /*
   * Everything from here on is best-effort. Any failure leaves the
   * Redemption in a state the retry job can pick up (commissionAmount
   * set, commissionReportedAt null) — so these are caught and
   * swallowed rather than propagated. The webhook already returns 200
   * for this part; Shopify must not retry it, since replaying a
   * partially-completed attempt is exactly what the retry job is for.
   */
  try {
    /*
     * Calculate the Shopify billing amount only once.
     *
     * Shopify App Pricing is currently denominated in USD. The original
     * commission remains stored in the merchant's order currency.
     *
     * If this webhook is retried, reuse the stored USD amount and FX
     * rate rather than fetching a new exchange rate.
     */
    let shopifyBillingAmount = redemption.shopifyBillingAmount;
    let shopifyExchangeRate = redemption.shopifyExchangeRate;
    let shopifyExchangeRateAt = redemption.shopifyExchangeRateAt;

    if (shopifyBillingAmount == null) {
      const conversion = await convertCurrency(
        commissionAmount,
        commissionCurrency,
        SHOPIFY_BILLING_CURRENCY
      );

      shopifyBillingAmount = conversion.convertedAmount;
      shopifyExchangeRate = conversion.rate;
      shopifyExchangeRateAt = new Date(conversion.rateTimestamp);

      if (
        !Number.isFinite(shopifyBillingAmount) ||
        shopifyBillingAmount <= 0
      ) {
        throw new Error(
          `Invalid Shopify billing amount computed for order ${shopifyOrderId}`
        );
      }

      redemption = await prisma.redemption.update({
        where: { id: redemption.id },
        data: {
          shopifyBillingAmount,
          shopifyBillingCurrency: SHOPIFY_BILLING_CURRENCY,
          shopifyExchangeRate,
          shopifyExchangeRateAt,
        },
      });

      console.log(
        `💱 Order ${shopifyOrderId}: ${commissionAmount.toFixed(2)} ${commissionCurrency} ` +
          `→ ${shopifyBillingAmount.toFixed(2)} ${SHOPIFY_BILLING_CURRENCY}`
      );
    }

    /*
     * App Pricing is the authoritative billing system for new
     * ProCircle installations. submitCommission() is the exact same
     * code path the retry job uses.
     */
    await submitCommission({ prisma, shopRecord, redemption });

    console.log(
      `💰 ProCircle commission reported for order ${shopifyOrderId}: ` +
        `${commissionAmount.toFixed(2)} ${commissionCurrency} ` +
        `→ ${shopifyBillingAmount.toFixed(2)} ${SHOPIFY_BILLING_CURRENCY}`
    );
  } catch (err) {
    if (err instanceof SystemicBillingError) {
      console.error(
        `🚨 [ALERT] Systemic billing error while reporting order ${shopifyOrderId} — ` +
          `check credentials/Partner API connectivity. Leaving for retry job: ${err.message}`
      );
    } else {
      console.error(
        `❌ Commission reporting failed for order ${shopifyOrderId}; commission remains pending for retry job: ${err.message}`
      );
    }
    // Swallowed deliberately — see comment above.
  }
}
