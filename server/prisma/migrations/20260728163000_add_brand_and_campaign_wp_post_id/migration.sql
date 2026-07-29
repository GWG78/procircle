-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN     "wpPostId" INTEGER;

-- CreateTable
CREATE TABLE "Brand" (
    "id" SERIAL NOT NULL,
    "brandId" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "wpBrandPostId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Brand_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Brand_brandId_key" ON "Brand"("brandId");

-- CreateIndex
CREATE UNIQUE INDEX "Brand_shopDomain_key" ON "Brand"("shopDomain");
