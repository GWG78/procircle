/*
  Warnings:

  - Added the required column `userId` to the `Discount` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "Discount" ADD COLUMN     "email" TEXT,
ADD COLUMN     "userId" TEXT NOT NULL;
