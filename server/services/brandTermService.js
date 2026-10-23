// services/brandTermService.js
//
// Owns the Shop.wpBrandTermId cache (the shop's campaign_brand term on
// procircle.io). The ID is cached once and reused, so if the term is ever
// deleted or the WordPress database is replaced (manual cleanup, a restore,
// a hosting migration), every later call against it 404s with
// rest_term_invalid. These helpers detect that, re-resolve the term by
// shop domain (same key routes/campaigns.mjs uses), re-cache it, and retry.

import prisma from "../prismaClient.js";
import { getOrCreateWpTermId, setWpTermLogo, wpTermExists } from "./wordpress.js";

/**
 * Re-resolves the shop's campaign_brand term by shop domain (finding an
 * existing term or creating a new one), caches it on Shop, and attaches the
 * cached logo if there is one. Returns the term ID, or null on failure.
 */
async function refreshBrandTermId(shop) {
  const { id } = await getOrCreateWpTermId("campaign_brand", shop.shopDomain);
  if (!id) return null;

  await prisma.shop.update({ where: { id: shop.id }, data: { wpBrandTermId: id } });
  console.log(`🔁 wpBrandTermId for ${shop.shopDomain}: ${shop.wpBrandTermId ?? "none"} → ${id}`);

  if (shop.logoWpAttachmentId) {
    await setWpTermLogo(id, shop.logoWpAttachmentId);
  }
  return id;
}

/**
 * Returns a campaign_brand term ID that is known to exist, creating or
 * re-resolving it if the cached one is missing or stale. Costs one extra
 * GET when a cached ID exists. If WordPress can't be reached to check, the
 * cached ID is returned as-is rather than churning the cache.
 */
async function ensureBrandTermId(shop) {
  if (shop.wpBrandTermId) {
    const exists = await wpTermExists(shop.wpBrandTermId);
    if (exists !== false) return shop.wpBrandTermId;
    console.warn(`⚠️ Cached wpBrandTermId ${shop.wpBrandTermId} for ${shop.shopDomain} no longer exists in WordPress — re-resolving`);
  }
  return refreshBrandTermId(shop);
}

/**
 * Pushes a newly uploaded logo onto the shop's campaign_brand term.
 * Shops with no term yet are left alone (the logo stays cached on Shop and
 * is attached when the first campaign creates the term). A stale cached
 * term is re-resolved and the push retried once.
 * Returns true if the logo is now on a live term, false otherwise.
 */
async function pushBrandLogo(shop, attachmentId) {
  if (!shop.wpBrandTermId) return false;

  const first = await setWpTermLogo(shop.wpBrandTermId, attachmentId);
  if (first.ok) return true;
  if (!first.notFound) return false;

  console.warn(`⚠️ Cached wpBrandTermId ${shop.wpBrandTermId} for ${shop.shopDomain} no longer exists in WordPress — re-resolving`);
  // refreshBrandTermId attaches shop.logoWpAttachmentId, so pass the new one.
  const newId = await refreshBrandTermId({ ...shop, logoWpAttachmentId: attachmentId });
  return Boolean(newId);
}

export { ensureBrandTermId, pushBrandLogo };
