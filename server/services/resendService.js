// services/resendService.js
//
// Sends the post-redemption discount-code email via Resend, replacing the
// old Make.com webhook (MAKE_WEBHOOK_URL, now removed — see
// makeWebhookService.js) — Make.com was never actually configured for this
// flow, so no email was ever delivered. Mirrors the Resend pattern already
// used in the Apps Script project for org-invite/member-verification email
// (same sendEmail_ shape, same "from" address).

const RESEND_API_KEY = process.env.RESEND_API_KEY;
// Sends from the contact.procircle.io subdomain, not bare procircle.io —
// matches the Apps Script project's RESEND_FROM: Resend recommends
// verifying a dedicated subdomain so its reputation stays isolated from
// the root domain.
const RESEND_FROM = "ProCircle <noreply@contact.procircle.io>";

/**
 * Sends an email via the Resend API. Returns true on a 2xx response, false
 * otherwise — never throws, so a failed send doesn't break whichever flow
 * triggered it (sendCodeEmail's caller depends on this never throwing —
 * see routes/redemptions.mjs's Stage 2 comment).
 */
async function sendEmail(to, subject, html) {
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${RESEND_API_KEY}`,
      },
      body: JSON.stringify({ from: RESEND_FROM, to, subject, html }),
    });

    if (!response.ok) {
      const body = await response.text();
      console.error(`[ALERT] sendEmail: Resend failed for "${subject}" to ${to} (HTTP ${response.status}) — ${body}`);
      return false;
    }

    return true;
  } catch (err) {
    console.error(`[ALERT] sendEmail: Resend request error for "${subject}" to ${to} — ${err.message}`);
    return false;
  }
}

/**
 * Emails a member their discount code/link after a successful redemption.
 * Never throws — access has already been granted by the time this is
 * called (see routes/redemptions.mjs Stage 1/Stage 2 split), so a failed
 * send here must never turn that real success into an error response.
 * campaignName isn't shown in the email copy (discountAmount + brandName
 * carry that context instead) but is kept in the signature for the
 * [ALERT] failure-log line below.
 */
async function sendCodeEmail({
  memberEmail,
  memberFirstName,
  discountAmount,
  discountCode,
  discountLink,
  campaignName,
  brandName,
}) {
  const greetingName = memberFirstName || "there";

  const html = `
    <p>Hi ${greetingName},</p>
    <p>Your <strong>${discountAmount} discount</strong> at ${brandName} is ready — click below to apply it automatically at checkout:</p>
    <p><a href="${discountLink}" style="display:inline-block;padding:10px 20px;background:#111;color:#fff;text-decoration:none;border-radius:4px;">Get my discount</a></p>
    <p>Or enter this code at checkout: <strong>${discountCode}</strong></p>
    <p>Questions? Reach us at <a href="mailto:hello@procircle.io">hello@procircle.io</a>.</p>
  `;

  const sent = await sendEmail(memberEmail, `Your ${discountAmount} discount at ${brandName} is ready`, html);

  if (!sent) {
    console.error(
      `[ALERT] sendCodeEmail: member ${memberEmail} was granted access but will NOT receive their code email. Campaign: ${campaignName}.`
    );
  }
}

export { sendEmail, sendCodeEmail };
