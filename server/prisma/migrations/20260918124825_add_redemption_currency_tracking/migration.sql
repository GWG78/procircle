-- AlterTable
ALTER TABLE "Redemption" ADD COLUMN     "commissionCurrency" TEXT,
ADD COLUMN     "orderCurrency" TEXT,
ADD COLUMN     "shopifyBillingAmount" DOUBLE PRECISION,
ADD COLUMN     "shopifyBillingCurrency" TEXT,
ADD COLUMN     "shopifyExchangeRate" DOUBLE PRECISION;
