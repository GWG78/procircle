// server/webhooks/customersRedact.mjs
import { PrismaClient } from "@prisma/client";
import { logDataAccess } from "../utils/accessLog.js";

const prisma = new PrismaClient();

export default async function customersRedactHandler(topic, shop, body) {
  const customerEmail = body?.customer?.email;
  const shopifyCustomerId = body?.customer?.id ? String(body.customer.id) : null;

  console.log(
    `🗑️ Customer redact request for shop: ${shop}, customer: ${customerEmail || shopifyCustomerId}`
  );

  try {
    const shopRecord = await prisma.shop.findUnique({ where: { shopDomain: shop } });
    if (!shopRecord) {
      console.log(`⚪ No Shop record found for ${shop}. Nothing to redact.`);
      return;
    }

    let member = customerEmail
      ? await prisma.member.findUnique({ where: { email: customerEmail } })
      : null;

    if (!member && shopifyCustomerId) {
      // shopifyCustomerId isn't globally unique in our schema (only the
      // memberId+shopId pair is), so resolve it scoped to this shop.
      const link = await prisma.memberShopifyLink.findFirst({
        where: { shopId: shopRecord.id, shopifyCustomerId },
        include: { member: true },
      });
      member = link?.member || null;
    }

    if (!member) {
      console.log(`⚪ No matching Member found for redact request (shop: ${shop}). Nothing to redact.`);
      return;
    }

    logDataAccess({
      action: 'READ',
      dataType: 'MemberShopifyLink',
      shop,
      requestedBy: 'shopify-gdpr-webhook',
      recordCount: 1,
      fields: ['shopifyCustomerId'],
    });

    // Scoped to this shop only. A Member's identity (email/name) is
    // independent of any one brand — the same Member can be linked to
    // other shops via separate MemberShopifyLink rows, and a redact
    // request from one shop's customer must not wipe that identity
    // everywhere (it previously did — see SENTINEL_AND_AUTH_FOLLOWUPS.md).
    // Only this shop's link is removed; Member.email/firstName/lastName/
    // socialLinks are never touched here, regardless of whether this was
    // the member's last remaining shop link.
    const { count } = await prisma.memberShopifyLink.deleteMany({
      where: { memberId: member.id, shopId: shopRecord.id },
    });

    logDataAccess({
      action: 'REDACT',
      dataType: 'MemberShopifyLink',
      shop,
      requestedBy: 'shopify-gdpr-webhook',
      recordCount: count,
      fields: ['shopifyCustomerId'],
    });

    console.log(`✅ Redacted shop-scoped link for Member ${member.id} (shop: ${shop}, ${count} link row(s) removed)`);
  } catch (error) {
    console.error(`❌ Failed to redact customer for shop ${shop}:`, error);
  }
}
