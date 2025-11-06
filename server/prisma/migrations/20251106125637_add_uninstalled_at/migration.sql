-- AlterTable
ALTER TABLE "Discount" ADD COLUMN     "active" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "uninstalledAt" TIMESTAMP(3);
