-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'active';
ALTER TABLE "Campaign" ADD COLUMN     "pausedAt" TIMESTAMP(3);
ALTER TABLE "Campaign" ADD COLUMN     "endedAt" TIMESTAMP(3);

-- Migrate data: existing inactive campaigns become "paused" (nothing was
-- ever "ended" under the old active/inactive model).
UPDATE "Campaign" SET "status" = 'paused' WHERE "active" = false;

-- AlterTable
ALTER TABLE "Campaign" DROP COLUMN "active";
