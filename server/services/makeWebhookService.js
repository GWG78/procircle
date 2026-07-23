// services/makeWebhookService.js
//
// Triggers Make.com scenarios: emailing a member the campaign discount link,
// and syncing completed order data to Google Sheets.

// Deliberately never throws — a successful Shopify customer-add (which
// always happens before this is called, see routes/redemptions.mjs) must
// result in Redemption.status: "confirmed" regardless of whether the
// code-delivery email actually went out. Confirmed is what makes the
// accessExpiresAt window and the daily expiry cron apply to this member;
// if this threw and the caller marked the redemption "failed" instead,
// the member would stay on the Shopify discount's customer list forever
// with no code path left to remove them (dailyExpiryJob.mjs only ever
// queries status: "confirmed").
//
// That tradeoff means a real access grant can now silently have no email
// behind it, which is a support/reliability gap, not an access leak — so
// it's logged with an ALERT tag distinct from ordinary console.warn noise,
// meant to be noticeable to whoever monitors these logs (e.g. grep/alert
// on "[ALERT]").
async function triggerCodeEmail({ memberEmail, discountLink, campaignName, brandName }) {
  const webhookUrl = process.env.MAKE_WEBHOOK_URL;
  if (!webhookUrl) {
    console.error(
      `[ALERT] triggerCodeEmail: MAKE_WEBHOOK_URL not set — member ${memberEmail} was granted access but will NOT receive their code email. Campaign: ${campaignName}.`
    );
    return;
  }

  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ memberEmail, discountLink, campaignName, brandName }),
    });

    if (!res.ok) {
      console.error(
        `[ALERT] triggerCodeEmail: Make.com webhook failed (${res.status}) — member ${memberEmail} was granted access but will NOT receive their code email. Campaign: ${campaignName}.`
      );
    }
  } catch (err) {
    console.error(
      `[ALERT] triggerCodeEmail: request to Make.com failed (${err.message}) — member ${memberEmail} was granted access but will NOT receive their code email. Campaign: ${campaignName}.`
    );
  }
}

async function triggerOrderSync({ memberEmail, campaignName, brandName, shopifyOrderId, orderAmount, orderCompletedAt }) {
  const webhookUrl = process.env.MAKE_ORDER_SYNC_WEBHOOK_URL;
  if (!webhookUrl) {
    console.warn("MAKE_ORDER_SYNC_WEBHOOK_URL not set — skipping order sync");
    return;
  }

  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      memberEmail,
      campaignName,
      brandName,
      shopifyOrderId,
      orderAmount,
      orderCompletedAt,
    }),
  });

  if (!res.ok) throw new Error(`Make.com order sync failed: ${res.status}`);
}

async function triggerExpiryReminder({ memberEmail, campaignName, brandName, accessExpiresAt, discountLink }) {
  const webhookUrl = process.env.MAKE_EXPIRY_REMINDER_WEBHOOK_URL;
  if (!webhookUrl) {
    console.warn("MAKE_EXPIRY_REMINDER_WEBHOOK_URL not set — skipping reminder");
    return;
  }

  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ memberEmail, campaignName, brandName, accessExpiresAt, discountLink }),
  });

  if (!res.ok) throw new Error(`Expiry reminder webhook failed: ${res.status}`);
}

async function triggerExpiryNotification({ memberEmail, campaignName, brandName }) {
  const webhookUrl = process.env.MAKE_EXPIRY_NOTIFICATION_WEBHOOK_URL;
  if (!webhookUrl) {
    console.warn("MAKE_EXPIRY_NOTIFICATION_WEBHOOK_URL not set — skipping notification");
    return;
  }

  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ memberEmail, campaignName, brandName }),
  });

  if (!res.ok) throw new Error(`Expiry notification webhook failed: ${res.status}`);
}

export { triggerCodeEmail, triggerOrderSync, triggerExpiryReminder, triggerExpiryNotification };
