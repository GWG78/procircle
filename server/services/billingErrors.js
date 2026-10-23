// server/services/billingErrors.js
//
// Error classes used to classify commission-billing failures so the
// webhook handler and the retry job can react appropriately.
//
// - SystemicBillingError: our own credentials/connectivity are broken
//   (bad API key/secret, Partner API unreachable, token endpoint down).
//   Not specific to any one order. The retry job must abort the whole
//   run on this — incrementing per-record retry counts would burn
//   through every pending record's budget for a problem that has
//   nothing to do with those records.
//
// - RetryableBillingError: transient (network error, 429, 5xx). Worth
//   retrying with backoff.
//
// - PermanentBillingError: this specific record cannot succeed as-is
//   (bad request, misconfiguration, no active subscription). Set
//   `immediate: true` only when no amount of waiting/retrying could
//   ever fix it (e.g. the shop's plan is missing the commission meter
//   entirely) — that skips the retry threshold and fails right away.
//   Leave `immediate: false` (default) when the merchant could resolve
//   it themselves between retries (e.g. no active subscription yet).

export class SystemicBillingError extends Error {
  constructor(message, { cause } = {}) {
    super(message);
    this.name = "SystemicBillingError";
    if (cause) this.cause = cause;
  }
}

export class RetryableBillingError extends Error {
  constructor(message, { status, cause } = {}) {
    super(message);
    this.name = "RetryableBillingError";
    this.status = status;
    if (cause) this.cause = cause;
  }
}

export class PermanentBillingError extends Error {
  constructor(message, { status, immediate = false, cause } = {}) {
    super(message);
    this.name = "PermanentBillingError";
    this.status = status;
    this.immediate = immediate;
    if (cause) this.cause = cause;
  }
}
