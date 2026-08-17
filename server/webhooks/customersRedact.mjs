// server/webhooks/customersRedact.mjs
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

export default async function customersRedactHandler(topic, shop, body) {
  const customerEmail = body?.customer?.email;
  const shopifyCustomerId = body?.customer?.id ? String(body.customer.id) : null;

  console.log(
    `🗑️ Customer redact request for shop: ${shop}, customer: ${customerEmail || shopifyCustomerId}`
  );

  try {
    let member = customerEmail
      ? await prisma.member.findUnique({ where: { email: customerEmail } })
      : null;

    if (!member && shopifyCustomerId) {
      // shopifyCustomerId isn't globally unique in our schema (only the
      // memberId+shopId pair is), so resolve it scoped to this shop.
      const shopRecord = await prisma.shop.findUnique({ where: { shopDomain: shop } });
      if (shopRecord) {
        const link = await prisma.memberShopifyLink.findFirst({
          where: { shopId: shopRecord.id, shopifyCustomerId },
          include: { member: true },
        });
        member = link?.member || null;
      }
    }

    if (!member) {
      console.log(`⚪ No matching Member found for redact request (shop: ${shop}). Nothing to redact.`);
      return;
    }

    // Member.email is non-nullable + unique, so it can't be set to literal
    // null — overwrite with a synthetic unique value instead. firstName,
    // lastName, and socialLinks are nullable and cleared outright. The row
    // itself is kept (never deleted) since it may still be referenced by
    // Redemption records — see prisma/schema.prisma.
    await prisma.member.update({
      where: { id: member.id },
      data: {
        email: `redacted-member-${member.id}@deleted.procircle.invalid`,
        firstName: null,
        lastName: null,
        socialLinks: null,
      },
    });

    console.log(`✅ Redacted PII for Member ${member.id} (shop: ${shop})`);
  } catch (error) {
    console.error(`❌ Failed to redact customer for shop ${shop}:`, error);
  }
}
