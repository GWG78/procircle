// services/eligibilityService.js
//
// Determines which campaigns a member is eligible to see/redeem.

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
  const now = new Date();

  const campaigns = await prisma.campaign.findMany({
    where: {
      active: true,
      AND: [
        { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
        { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
      ],
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

    const alreadyRedeemed = await prisma.redemption.findFirst({
      where: {
        memberId: member.id,
        campaignId: campaign.id,
        status: "confirmed",
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
  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    include: { filters: true },
  });

  if (!campaign || !campaign.active) {
    return { eligible: false, reason: "not_found" };
  }

  if (!memberMatchesFilters(member, campaign.filters)) {
    return { eligible: false, reason: "not_eligible" };
  }

  const alreadyRedeemed = await prisma.redemption.findFirst({
    where: {
      memberId: member.id,
      campaignId: campaign.id,
      status: "confirmed",
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

export { getOffersForMember, checkEligibility };
