-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "billingSubscriptionId" TEXT,
ADD COLUMN     "commissionRate" DOUBLE PRECISION NOT NULL DEFAULT 0.08;
