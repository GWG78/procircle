// server/services/brandProfileService.js
//
// Single source of truth for whether a shop's brand profile is complete —
// used by the first-run /setup gate (web/src/App.jsx, via GET /api/settings)
// and independently re-checked server-side before a campaign is allowed to
// go active (routes/campaigns.mjs). Brand logo is intentionally excluded —
// optional, not required to pass setup or activate a campaign.

/**
 * @param {{ description?: string|null, contactName?: string|null, contactEmail?: string|null }|null} settings
 */
function isBrandProfileComplete(settings) {
  if (!settings) return false;
  return (
    !!settings.description?.trim() &&
    !!settings.contactName?.trim() &&
    !!settings.contactEmail?.trim()
  );
}

export { isBrandProfileComplete };
