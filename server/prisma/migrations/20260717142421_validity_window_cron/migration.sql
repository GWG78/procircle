-- AlterTable
ALTER TABLE "Campaign" DROP COLUMN "expiresAt",
ADD COLUMN     "validForDays" INTEGER NOT NULL DEFAULT 30;

-- AlterTable
ALTER TABLE "Redemption" DROP COLUMN "redeemedAt",
ADD COLUMN     "accessExpiresAt" TIMESTAMP(3),
ADD COLUMN     "accessGrantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "reminderSentAt" TIMESTAMP(3);

