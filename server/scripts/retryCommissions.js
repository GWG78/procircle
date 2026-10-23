// server/scripts/retryCommissions.js
//
// Retries commission reporting for Redemptions that are pending
// (commissionAmount set, commissionReportedAt null, not permanently
// failed). Run on a schedule by Render's cron service — standalone
// process, own Prisma client, disconnects when done. Mirrors
// scripts/dailyExpiryJob.mjs.
//
// Usage:
//   node scripts/retryCommissions.js              Run the retry batch
//   node scripts/retryCommissions.js --dry-run     List what would be
//                                                   retried; no writes,
//                                                   no calls to Shopify
//                                                   or CurrencyAPI
//   node scripts/retryCommissions.js --reset 123   Clear
//                                                   commissionFailedPermanently
//                                                   and the retry count
//                                                   for Redemption #123
//
// Concurrency safety: before processing a record, the job claims it
// with an optimistic-lock update — `updateMany` matching the exact
// commissionLastAttemptAt value just read, writing a new timestamp.
// Postgres's `SELECT ... FOR UPDATE SKIP LOCKED` would do the same job
// but needs raw SQL since Prisma doesn't expose it; this compare-and-
// swap achieves the same "only one run wins" guarantee as a plain ORM
// call. If two runs overlap (e.g. a manual --dry-run... no, dry-run
// never claims; a manual run overlapping the cron tick) and both read
// the same row, only one's updateMany affects a row (count: 1); the
// other sees count: 0 and skips it.
//
// Backoff: a record is only eligible once
// now - commissionLastAttemptAt >= 15min * 2^commissionRetryCount
// (capped at 24h). The cron itself runs every 15 minutes, so this is
// the practical minimum gap between attempts, growing with each
// failure.

import { PrismaClient } from "@prisma/client";
import { convertCurrency } from "../services/currencyService.js";
import { submitCommission } from "../services/commissionRetryService.js";
import {
  SystemicBillingError,
  RetryableBillingError,
  PermanentBillingError,
} from "../services/billingErrors.js";

const prisma = new PrismaClient();

const BATCH_SIZE = 50;
const CANDIDATE_POOL_SIZE = 200; // fetched before backoff-filtering down to BATCH_SIZE
const BASE_BACKOFF_MINUTES = 15;
const MAX_BACKOFF_MINUTES = 24 * 60;
const MAX_ATTEMPTS = Number(process.env.COMMISSION_RETRY_MAX_ATTEMPTS || 10);
const SHOPIFY_BILLING_CURRENCY = "USD";

const args = process.argv.slice(2);
const isDryRun = args.includes("--dry-run");
const resetIndex = args.indexOf("--reset");
const resetId = resetIndex !== -1 ? Number(args[resetIndex + 1]) : null;

function backoffDueAt(lastAttemptAt, retryCount) {
  if (!lastAttemptAt) return null; // never attempted — always due
  const minutes = Math.min(
    BASE_BACKOFF_MINUTES * 2 ** retryCount,
    MAX_BACKOFF_MINUTES
  );
  return new Date(lastAttemptAt.getTime() + minutes * 60_000);
}

async function resetRecord(id) {
  const redemption = await prisma.redemption.findUnique({ where: { id } });

  if (!redemption) {
    console.error(`[retryCommissions] No Redemption found with id ${id}`);
    process.exit(1);
  }

  await prisma.redemption.update({
    where: { id },
    data: {
      commissionFailedPermanently: false,
      commissionRetryCount: 0,
      commissionLastError: null,
      commissionLastAttemptAt: null,
    },
  });

  console.log(
    `[retryCommissions] Reset Redemption ${id} (order ${redemption.shopifyOrderId}) — eligible for immediate retry on next run.`
  );
}

async function run() {
  console.log(`[retryCommissions] Starting at ${new Date().toISOString()}${isDryRun ? " (DRY RUN)" : ""}`);

  const now = new Date();

  const candidates = await prisma.redemption.findMany({
    where: {
      commissionAmount: { not: null },
      commissionReportedAt: null,
      commissionFailedPermanently: false,
    },
    orderBy: { orderCompletedAt: "asc" },
    take: CANDIDATE_POOL_SIZE,
    include: {
      campaign: { include: { shop: true } },
    },
  });

  const due = candidates
    .filter((r) => {
      const dueAt = backoffDueAt(r.commissionLastAttemptAt, r.commissionRetryCount);
      return !dueAt || dueAt <= now;
    })
    .slice(0, BATCH_SIZE);

  console.log(
    `[retryCommissions] ${candidates.length} pending record(s), ${due.length} due this run`
  );

  if (isDryRun) {
    for (const r of due) {
      console.log(
        `[retryCommissions] [DRY RUN] would retry Redemption ${r.id} ` +
          `order ${r.shopifyOrderId} shop ${r.campaign.shop.shopDomain} ` +
          `commission ${r.commissionAmount} ${r.commissionCurrency} ` +
          `billing=${r.shopifyBillingAmount ?? "NOT YET CONVERTED"} ` +
          `attempts=${r.commissionRetryCount} lastError=${r.commissionLastError ?? "none"}`
      );
    }
    console.log(`[retryCommissions] Dry run done — no writes, no external calls.`);
    return;
  }

  let processed = 0;
  let succeeded = 0;

  for (let redemption of due) {
    // Claim: optimistic lock on commissionLastAttemptAt. If another run
    // already claimed this row since we read it, count will be 0.
    const claim = await prisma.redemption.updateMany({
      where: {
        id: redemption.id,
        commissionReportedAt: null,
        commissionFailedPermanently: false,
        commissionLastAttemptAt: redemption.commissionLastAttemptAt,
      },
      data: { commissionLastAttemptAt: now },
    });

    if (claim.count === 0) {
      console.log(`[retryCommissions] Redemption ${redemption.id} claimed by another run — skipping`);
      continue;
    }

    processed++;
    const shopRecord = redemption.campaign.shop;

    try {
      let shopifyBillingAmount = redemption.shopifyBillingAmount;

      if (shopifyBillingAmount == null) {
        // Not yet converted (e.g. the webhook's FX step failed). Convert
        // once here and persist before attempting submission — never
        // re-convert an order that already has a stored billing amount.
        let conversion;
        try {
          conversion = await convertCurrency(
            redemption.commissionAmount,
            redemption.commissionCurrency,
            SHOPIFY_BILLING_CURRENCY
          );
        } catch (fxErr) {
          if (String(fxErr.message).includes("CURRENCY_API_KEY is not configured")) {
            throw new SystemicBillingError(
              `CurrencyAPI misconfigured: ${fxErr.message}`,
              { cause: fxErr }
            );
          }
          // CurrencyAPI being down/flaky is transient, not this record's fault.
          throw new RetryableBillingError(
            `Currency conversion failed for order ${redemption.shopifyOrderId}: ${fxErr.message}`,
            { cause: fxErr }
          );
        }

        shopifyBillingAmount = conversion.convertedAmount;

        redemption = await prisma.redemption.update({
          where: { id: redemption.id },
          data: {
            shopifyBillingAmount,
            shopifyBillingCurrency: SHOPIFY_BILLING_CURRENCY,
            shopifyExchangeRate: conversion.rate,
            shopifyExchangeRateAt: new Date(conversion.rateTimestamp),
          },
        });

        console.log(
          `[retryCommissions] Redemption ${redemption.id}: converted ${redemption.commissionAmount} ${redemption.commissionCurrency} ` +
            `→ ${shopifyBillingAmount.toFixed(2)} ${SHOPIFY_BILLING_CURRENCY}`
        );
      }

      await submitCommission({ prisma, shopRecord, redemption });

      succeeded++;
      console.log(
        `[retryCommissions] ✅ Redemption ${redemption.id} (order ${redemption.shopifyOrderId}) reported successfully on retry.`
      );
    } catch (err) {
      if (err instanceof SystemicBillingError) {
        console.error(
          `🚨 [ALERT] [retryCommissions] Systemic billing error — aborting the rest of this run. ` +
            `Processed ${processed}/${due.length} before stopping. Error: ${err.message}`
        );
        await prisma.$disconnect();
        process.exit(1);
      }

      const immediate = err instanceof PermanentBillingError && err.immediate === true;
      const newRetryCount = redemption.commissionRetryCount + 1;
      const failPermanently = immediate || newRetryCount >= MAX_ATTEMPTS;

      await prisma.redemption.update({
        where: { id: redemption.id },
        data: {
          commissionRetryCount: newRetryCount,
          commissionLastError: String(err.message).slice(0, 2000),
          commissionFailedPermanently: failPermanently,
        },
      });

      if (failPermanently) {
        console.error(
          `🚨 [ALERT] [retryCommissions] Redemption ${redemption.id} (order ${redemption.shopifyOrderId}) ` +
            `marked PERMANENTLY FAILED after ${newRetryCount} attempt(s)${immediate ? " (unrecoverable error)" : ""}: ${err.message}`
        );
      } else {
        console.error(
          `[retryCommissions] Redemption ${redemption.id} (order ${redemption.shopifyOrderId}) ` +
            `attempt ${newRetryCount}/${MAX_ATTEMPTS} failed: ${err.message}`
        );
      }
    }
  }

  console.log(
    `[retryCommissions] Done at ${new Date().toISOString()} — processed ${processed}, succeeded ${succeeded}`
  );
}

async function main() {
  try {
    if (resetId != null) {
      if (!Number.isInteger(resetId)) {
        console.error("[retryCommissions] --reset requires a numeric Redemption id");
        process.exit(1);
      }
      await resetRecord(resetId);
      return;
    }

    await run();
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error("[retryCommissions] Fatal error:", err);
  prisma.$disconnect();
  process.exit(1);
});
