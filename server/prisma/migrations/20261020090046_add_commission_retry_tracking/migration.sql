-- AlterTable
ALTER TABLE "Redemption" ADD COLUMN     "commissionFailedPermanently" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "commissionLastAttemptAt" TIMESTAMP(3),
ADD COLUMN     "commissionLastError" TEXT,
ADD COLUMN     "commissionRetryCount" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "Redemption_commissionAmount_commissionReportedAt_commission_idx" ON "Redemption"("commissionAmount", "commissionReportedAt", "commissionFailedPermanently");
