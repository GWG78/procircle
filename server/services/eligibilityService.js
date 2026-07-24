// services/eligibilityService.js
//
// Determines which campaigns a member is eligible to see/redeem.
//
// No email lookup lives here — getOffersForMember/checkEligibility both
// take an already-loaded Member row, not an email string. The email→Member
// lookup (and its lowercase normalization) happens in the caller
// (routes/redemptions.mjs); by the time a member reaches these functions
// it's already the correctly-cased DB row.

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

/**
 * Groups a campaign's filters by filterType and checks that the member
 * matches at least one value in every group. A campaign with no filters
 * is open to all members.
 */
function memberMatchesFilters(member, filters) {
  if (!filters.length) return true;

  const groups = new Map();
  for (const filter of filters) {
    if (!groups.has(filter.filterType)) groups.set(filter.filterType, []);
    groups.get(filter.filterType).push(filter.value);
  }

  for (const [filterType, values] of groups) {
    const memberValue = member[filterType];
    if (!memberValue || !values.includes(memberValue)) {
      return false;
    }
  }

  return true;
}

/**
 * Returns all campaigns a member is eligible to see, each annotated with
 * a status of "available" or "fully_claimed". Campaigns the member has
 * already confirmed-redeemed are excluded entirely.
 */
async function getOffersForMember(member) {
  if (!member.verified) return [];

  const now = new Date();

  const campaigns = await prisma.campaign.findMany({
    where: {
      status: "active",
      OR: [{ startsAt: null }, { startsAt: { lte: now } }],
    },
    include: {
      filters: true,
      _count: {
        select: { redemptions: { where: { status: "confirmed" } } },
      },
    },
  });

  const eligible = [];

  for (const campaign of campaigns) {
    if (!memberMatchesFilters(member, campaign.filters)) continue;

    // A confirmed redemption only blocks re-requesting while its access
    // window is still open. Once accessExpiresAt has passed, the member
    // was (or will be) removed from the discount by the daily cron, so
    // they're free to re-join the queue — even before the cron has run.
    const alreadyRedeemed = await prisma.redemption.findFirst({
      where: {
        memberId: member.id,
        campaignId: campaign.id,
        status: "confirmed",
        OR: [{ accessExpiresAt: null }, { accessExpiresAt: { gt: now } }],
      },
    });
    if (alreadyRedeemed) continue;

    const confirmedCount = campaign._count.redemptions;
    const status =
      campaign.maxRedemptions != null && confirmedCount >= campaign.maxRedemptions
        ? "fully_claimed"
        : "available";

    eligible.push({ ...campaign, status });
  }

  return eligible;
}

/**
 * Point-in-time eligibility check performed at the moment of redemption
 * request, guarding against races between the offers list and the request.
 */
async function checkEligibility(member, campaignId) {
  if (!member.verified) {
    return { eligible: false, reason: "not_verified" };
  }

  const now = new Date();

  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    include: { filters: true },
  });

  if (!campaign || campaign.status !== "active") {
    return { eligible: false, reason: "not_found" };
  }

  // Mirrors getOffersForMember's startsAt filter — without this, a
  // "draft" campaign (active status, future startsAt, not yet shown in the
  // offers list) could still be claimed early via a direct API call.
  if (campaign.startsAt && campaign.startsAt > now) {
    return { eligible: false, reason: "not_started" };
  }

  if (!memberMatchesFilters(member, campaign.filters)) {
    return { eligible: false, reason: "not_eligible" };
  }

  // Same expiry-aware check as getOffersForMember — otherwise a member
  // whose window has closed would see the campaign as available in their
  // offers list but get rejected here, since this is the point-in-time
  // check that actually gates POST /request.
  const alreadyRedeemed = await prisma.redemption.findFirst({
    where: {
      memberId: member.id,
      campaignId: campaign.id,
      status: "confirmed",
      OR: [{ accessExpiresAt: null }, { accessExpiresAt: { gt: now } }],
    },
  });
  if (alreadyRedeemed) {
    return { eligible: false, reason: "already_redeemed" };
  }

  if (campaign.maxRedemptions != null) {
    const confirmedCount = await prisma.$transaction(async (tx) => {
      return tx.redemption.count({
        where: { campaignId: campaign.id, status: "confirmed" },
      });
    });

    if (confirmedCount >= campaign.maxRedemptions) {
      return { eligible: false, reason: "cap_reached" };
    }
  }

  return { eligible: true, reason: "ok" };
}

// Filter types that correspond to an actual Member column — "collection"
// filters restrict which products a discount applies to (a Shopify-side
// concern), not which members are eligible, so they're excluded here.
const MEMBER_ATTRIBUTE_FILTER_TYPES = new Set(["role", "country", "resort"]);

/**
 * Counts verified members matching a set of {filterType, value} pairs,
 * using the same AND-across-types/OR-within-type semantics as
 * memberMatchesFilters — but as a single DB-level count() rather than a
 * per-member JS scan, since this is called on every audience-filter
 * checkbox change (dashboard audience-size column, create-form live
 * counter) and needs to stay fast regardless of Member table size.
 */
async function countMatchingMembers(filters) {
  const groups = new Map();
  for (const filter of filters || []) {
    if (!MEMBER_ATTRIBUTE_FILTER_TYPES.has(filter.filterType)) continue;
    if (!groups.has(filter.filterType)) groups.set(filter.filterType, []);
    groups.get(filter.filterType).push(filter.value);
  }

  const and = [...groups.entries()]
    .filter(([, values]) => values.length > 0)
    .map(([filterType, values]) => ({ [filterType]: { in: values } }));

  return prisma.member.count({
    where: { verified: true, ...(and.length ? { AND: and } : {}) },
  });
}

export { getOffersForMember, checkEligibility, countMatchingMembers };
