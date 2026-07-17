// services/makeWebhookService.js
//
// Triggers Make.com scenarios: emailing a member the campaign discount link,
// and syncing completed order data to Google Sheets.

async function triggerCodeEmail({ memberEmail, discountLink, campaignName, brandName }) {
  const webhookUrl = process.env.MAKE_WEBHOOK_URL;
  if (!webhookUrl) throw new Error("MAKE_WEBHOOK_URL not set");

  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ memberEmail, discountLink, campaignName, brandName }),
  });

  if (!res.ok) throw new Error(`Make.com webhook failed: ${res.status}`);
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
