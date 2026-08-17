// server/webhooks/customersDataRequest.mjs
export default async function customersDataRequestHandler(topic, shop, body) {
  try {
    console.log(`📋 Customer data request received for shop: ${shop}`);
    console.log(`📋 Customer: ${JSON.stringify(body?.customer)}`);
    // Shopify only requires this endpoint exist and return 200 — no
    // automated data export is required, only that a process exists. For
    // v1 we log for manual/audit follow-up; this could later trigger an
    // email to the brand or an automated export.
  } catch (error) {
    console.error(`❌ Failed to log customer data request for shop ${shop}:`, error);
  }
}
