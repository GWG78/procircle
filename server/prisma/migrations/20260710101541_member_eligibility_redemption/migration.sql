-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN     "shopifySegmentId" TEXT;

-- AlterTable
ALTER TABLE "Redemption" DROP COLUMN "email",
DROP COLUMN "userId",
ADD COLUMN     "memberId" INTEGER NOT NULL,
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'pending';

-- CreateTable
CREATE TABLE "Member" (
    "id" SERIAL NOT NULL,
    "email" TEXT NOT NULL,
    "firstName" TEXT,
    "lastName" TEXT,
    "role" TEXT NOT NULL,
    "country" TEXT,
    "resort" TEXT,
    "yearsExperience" INTEGER,
    "socialLinks" JSONB,
    "qualifications" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Member_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemberShopifyLink" (
    "id" SERIAL NOT NULL,
    "memberId" INTEGER NOT NULL,
    "shopId" INTEGER NOT NULL,
    "shopifyCustomerId" TEXT NOT NULL,

    CONSTRAINT "MemberShopifyLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignFilter" (
    "id" SERIAL NOT NULL,
    "campaignId" INTEGER NOT NULL,
    "filterType" TEXT NOT NULL,
    "value" TEXT NOT NULL,

    CONSTRAINT "CampaignFilter_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Member_email_key" ON "Member"("email");

-- CreateIndex
CREATE UNIQUE INDEX "MemberShopifyLink_memberId_shopId_key" ON "MemberShopifyLink"("memberId", "shopId");

-- CreateIndex
CREATE INDEX "CampaignFilter_campaignId_idx" ON "CampaignFilter"("campaignId");

-- AddForeignKey
ALTER TABLE "Redemption" ADD CONSTRAINT "Redemption_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberShopifyLink" ADD CONSTRAINT "MemberShopifyLink_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberShopifyLink" ADD CONSTRAINT "MemberShopifyLink_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignFilter" ADD CONSTRAINT "CampaignFilter_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

