-- AlterTable
ALTER TABLE "Member" ADD COLUMN     "verificationToken" TEXT,
ADD COLUMN     "verificationTokenExpiresAt" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "Member_verificationToken_key" ON "Member"("verificationToken");

