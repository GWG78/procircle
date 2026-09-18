/*
  Warnings:

  - A unique constraint covering the columns `[commissionEventKey]` on the table `Redemption` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "Redemption" ADD COLUMN     "commissionAmount" DOUBLE PRECISION,
ADD COLUMN     "commissionEventKey" TEXT,
ADD COLUMN     "commissionReportedAt" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "Redemption_commissionEventKey_key" ON "Redemption"("commissionEventKey");
