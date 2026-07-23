// services/makeWebhookService.js
//
// Triggers Make.com scenarios: emailing a member the campaign discount link,
// syncing completed order data to Google Sheets, and the daily expiry
// reminder/notification pair.

// None of these ever throw — a failed Make.com call (missing config, non-2xx
// response, or network failure) must never abort the caller's real work.
// triggerCodeEmail in particular: the Shopify customer-add always happens
// before it's called (see routes/redemptions.mjs), so a throw here used to
// leave Redemption.status stuck at "failed" even though access was already
// granted — and dailyExpiryJob.mjs only ever queries status: "confirmed",
// so that member's Shopify customer ID would never get cleaned up. The same
// treatment is applied to the other three for consistency; dailyExpiryJob.mjs
// already wraps each redemption's processing in its own try/catch, so this
// isn't needed for batch isolation there, but it keeps a notification
// failure from being misreported as the whole expiry action failing.
//
// Each failure is logged with an [ALERT] tag distinct from ordinary
// console.warn noise, meant to be noticeable to whoever monitors these logs
// (e.g. grep/alert on "[ALERT]") — a missed webhook is a support/reliability
// gap, not something that should disappear silently.
//
// Returns true/false for success — callers that don't have anything to gate
// on it (triggerCodeEmail, triggerOrderSync, triggerExpiryNotification) just
// don't propagate the return value, which is unchanged for them. triggerExpiryReminder
// does propagate it, so dailyExpiryJob.mjs can leave reminderSentAt unset on
// failure and let the redemption retry on the next run.
async function postToMakeWebhook({ url, missingUrlContext, payload, failureContext }) {
  if (!url) {
    console.error(`[ALERT] ${missingUrlContext}`);
    return false;
  }

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      console.error(`[ALERT] ${failureContext} (HTTP ${res.status})`);
      return false;
    }

    return true;
  } catch (err) {
    console.error(`[ALERT] ${failureContext} (${err.message})`);
    return false;
  }
}

async function triggerCodeEmail({ memberEmail, discountLink, campaignName, brandName }) {
  const consequence = `member ${memberEmail} was granted access but will NOT receive their code email. Campaign: ${campaignName}.`;
  await postToMakeWebhook({
    url: process.env.MAKE_WEBHOOK_URL,
    missingUrlContext: `triggerCodeEmail: MAKE_WEBHOOK_URL not set — ${consequence}`,
    payload: { memberEmail, discountLink, campaignName, brandName },
    failureContext: `triggerCodeEmail: Make.com webhook failed — ${consequence}`,
  });
}

async function triggerOrderSync({ memberEmail, campaignName, brandName, shopifyOrderId, orderAmount, orderCompletedAt }) {
  const consequence = `order ${shopifyOrderId} for ${memberEmail} (campaign: ${campaignName}) will NOT be synced to Google Sheets.`;
  await postToMakeWebhook({
    url: process.env.MAKE_ORDER_SYNC_WEBHOOK_URL,
    missingUrlContext: `triggerOrderSync: MAKE_ORDER_SYNC_WEBHOOK_URL not set — ${consequence}`,
    payload: { memberEmail, campaignName, brandName, shopifyOrderId, orderAmount, orderCompletedAt },
    failureContext: `triggerOrderSync: Make.com webhook failed — ${consequence}`,
  });
}

// Returns true if the reminder was actually sent, false otherwise — callers
// (dailyExpiryJob.mjs) use this to decide whether to set reminderSentAt, so
// a failed attempt stays eligible for the reminder query and retries on the
// next run instead of being silently marked as sent.
async function triggerExpiryReminder({ memberEmail, campaignName, brandName, accessExpiresAt, discountLink }) {
  const consequence = `member ${memberEmail} will NOT receive their 48hr expiry reminder for campaign ${campaignName}.`;
  return postToMakeWebhook({
    url: process.env.MAKE_EXPIRY_REMINDER_WEBHOOK_URL,
    missingUrlContext: `triggerExpiryReminder: MAKE_EXPIRY_REMINDER_WEBHOOK_URL not set — ${consequence}`,
    payload: { memberEmail, campaignName, brandName, accessExpiresAt, discountLink },
    failureContext: `triggerExpiryReminder: Make.com webhook failed — ${consequence}`,
  });
}

async function triggerExpiryNotification({ memberEmail, campaignName, brandName }) {
  const consequence = `member ${memberEmail} will NOT receive their post-expiry re-engagement email for campaign ${campaignName}.`;
  await postToMakeWebhook({
    url: process.env.MAKE_EXPIRY_NOTIFICATION_WEBHOOK_URL,
    missingUrlContext: `triggerExpiryNotification: MAKE_EXPIRY_NOTIFICATION_WEBHOOK_URL not set — ${consequence}`,
    payload: { memberEmail, campaignName, brandName },
    failureContext: `triggerExpiryNotification: Make.com webhook failed — ${consequence}`,
  });
}

export { triggerCodeEmail, triggerOrderSync, triggerExpiryReminder, triggerExpiryNotification };
