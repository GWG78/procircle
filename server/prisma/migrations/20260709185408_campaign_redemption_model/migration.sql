-- DropForeignKey
ALTER TABLE "public"."Discount" DROP CONSTRAINT "Discount_shopId_fkey";

-- AlterTable
ALTER TABLE "ShopSettings" DROP COLUMN "allowedCountries",
DROP COLUMN "allowedMemberTypes",
DROP COLUMN "discountType",
DROP COLUMN "discountValue",
DROP COLUMN "expiryDays",
DROP COLUMN "maxDiscounts",
DROP COLUMN "oneTimeUse";

-- DropTable
DROP TABLE "public"."Discount";

-- CreateTable
CREATE TABLE "Campaign" (
    "id" SERIAL NOT NULL,
    "shopId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "discountType" TEXT NOT NULL DEFAULT 'percentage',
    "discountValue" DOUBLE PRECISION NOT NULL,
    "maxRedemptionsPerUser" INTEGER DEFAULT 1,
    "maxRedemptions" INTEGER,
    "targetAudience" TEXT NOT NULL DEFAULT 'all',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "startsAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Campaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Redemption" (
    "id" SERIAL NOT NULL,
    "campaignId" INTEGER NOT NULL,
    "userId" TEXT NOT NULL,
    "email" TEXT,
    "redeemedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "orderId" TEXT,
    "orderAmount" DOUBLE PRECISION,
    "discountCode" TEXT,

    CONSTRAINT "Redemption_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Campaign_slug_key" ON "Campaign"("slug");

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Redemption" ADD CONSTRAINT "Redemption_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

