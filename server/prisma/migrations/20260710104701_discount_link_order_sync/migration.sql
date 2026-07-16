-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN     "discountCode" TEXT,
ADD COLUMN     "discountLink" TEXT,
ADD COLUMN     "shopifyDiscountId" TEXT;

-- AlterTable
ALTER TABLE "Redemption" DROP COLUMN "discountCode",
DROP COLUMN "orderId",
ADD COLUMN     "orderCompletedAt" TIMESTAMP(3),
ADD COLUMN     "shopifyOrderId" TEXT;

