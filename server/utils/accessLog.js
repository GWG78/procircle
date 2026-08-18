/**
 * Access logging for protected customer data (Shopify Level 2 requirement)
 * Logs are captured by Render's persistent logging infrastructure.
 */

export function logDataAccess({ action, dataType, shop, requestedBy, recordCount, fields }) {
  const entry = {
    type: 'PROTECTED_DATA_ACCESS',
    timestamp: new Date().toISOString(),
    action,        // 'READ' | 'WRITE' | 'DELETE' | 'REDACT'
    dataType,      // e.g. 'Member.email', 'Member.name', 'Member'
    shop,          // shop domain the data belongs to, or null if not shop-scoped
    requestedBy,   // identity of the requesting caller (shop domain, webhook, or service name)
    recordCount,   // number of records affected (optional)
    fields,        // array of field names accessed (optional)
  };
  console.log(`[ACCESS_LOG] ${JSON.stringify(entry)}`);
}
