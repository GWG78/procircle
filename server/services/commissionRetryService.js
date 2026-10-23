// server/services/commissionRetryService.js
//
// Shared commission-submission logic used by both the orders/paid
// webhook (first-attempt path, webhooks/ordersPaid.mjs) and the retry
// job (scripts/retryCommissions.js), so the two paths can never drift
// apart.
//
// Expects the redemption to already have shopifyOrderId,
// commissionEventKey, and shopifyBillingAmount persisted (i.e. the FX
// conversion step has already happened) — this function does not do
// currency conversion itself.

import { fetchActiveSubscription } from "./partnerApi.js";
import { postUsageRecord } from "./usageRecord.js";
import { PermanentBillingError, SystemicBillingError } from "./billingErrors.js";

const COMMISSION_METER_HANDLE = "procircle-commish";

/**
 * Attempt to report a Redemption's commission to Shopify App Pricing
 * and persist commissionReportedAt on success.
 *
 * Throws SystemicBillingError / RetryableBillingError /
 * PermanentBillingError on failure (see billingErrors.js). Callers
 * decide what to do with each class — this function never swallows.
 */
export async function submitCommission({ prisma, shopRecord, redemption }) {
  const activeSubscription = await fetchActiveSubscription(
    shopRecord.shopifyShopId
  );

  if (!activeSubscription) {
    // Per-record, but NOT immediate: the merchant may activate a
    // subscription before the retry threshold is reached, so this
    // gets the normal number of chances rather than failing on attempt 1.
    throw new PermanentBillingError(
      `No active App Pricing subscription for ${shopRecord.shopDomain}`,
      { immediate: false }
    );
  }

  const commissionMeter = activeSubscription.items?.find(
    (item) => item.handle === COMMISSION_METER_HANDLE
  );

  if (!commissionMeter) {
    // SYSTEMIC, not per-record: a plan missing the commission meter is
    // a configuration problem that affects every shop on that plan, not
    // just this order. Aborting the whole run (and not incrementing any
    // record's retry count) avoids mass-marking every pending record as
    // permanently failed in one run because of one misconfigured plan.
    throw new SystemicBillingError(
      `Active App Pricing subscription for ${shopRecord.shopDomain} does not contain ${COMMISSION_METER_HANDLE} — plan misconfiguration`
    );
  }

  await postUsageRecord(
    shopRecord.shopifyShopId,
    redemption.shopifyBillingAmount,
    redemption.shopifyOrderId
  );

  await prisma.redemption.update({
    where: { id: redemption.id },
    data: { commissionReportedAt: new Date() },
  });
}
