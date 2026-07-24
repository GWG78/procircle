// server/routes/members.mjs
//
// Server-to-server endpoint for upserting Member rows — step 1 of the
// signup-bridge plan. Called by trusted backend callers only (Apps Script
// today, potentially WordPress later), never by end users directly, so it
// uses a shared-secret header rather than Shopify session auth.
import express from "express";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const router = express.Router();

// Shared-secret check, reusing GOOGLE_SHEET_SECRET — the same env var (and
// the same x-api-key header pattern) the old, now-deleted discounts.mjs
// used for its Google Sheets caller. Left unused since that route was
// deleted; repurposed here rather than introducing a new secret.
router.use((req, res, next) => {
  const token = req.headers["x-api-key"];
  if (!token || token !== process.env.GOOGLE_SHEET_SECRET) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }
  next();
});

/**
 * ===========================================================
 * POST /api/members
 *
 * Upserts a Member row by email. Idempotent — calling this twice with the
 * same email updates the existing row (firstName/lastName/role/country/
 * resort) rather than erroring or creating a duplicate, since Member.email
 * is a unique column and this uses a Prisma upsert keyed on it.
 *
 * Deliberately does not touch `verified`/`verifiedAt` — this endpoint only
 * syncs profile data; verification is a separate, not-yet-built step, and
 * leaving those fields out of both the create default and the update data
 * means an update never resets an already-verified member back to
 * unverified.
 *
 * Email is trimmed AND lowercased before the upsert — every other email
 * lookup that touches Member.email (this route, the redemption route's two
 * lookups) now normalizes the same way, so casing differences between
 * callers (e.g. a web form vs. Apps Script vs. a future WordPress
 * integration) never cause a mismatch. See routes/redemptions.mjs.
 * ===========================================================
 */
router.post("/", async (req, res) => {
  try {
    const { email, firstName, lastName, role, country, resort } = req.body || {};

    if (!email || typeof email !== "string" || !email.trim()) {
      return res.status(400).json({ success: false, error: "email is required" });
    }
    if (!role || typeof role !== "string" || !role.trim()) {
      return res.status(400).json({ success: false, error: "role is required" });
    }

    const cleanEmail = email.trim().toLowerCase();

    const data = {
      firstName: firstName != null && String(firstName).trim() ? String(firstName).trim() : null,
      lastName: lastName != null && String(lastName).trim() ? String(lastName).trim() : null,
      role: role.trim(),
      country: country != null && String(country).trim() ? String(country).trim() : null,
      resort: resort != null && String(resort).trim() ? String(resort).trim() : null,
    };

    const member = await prisma.member.upsert({
      where: { email: cleanEmail },
      update: data,
      create: { email: cleanEmail, ...data },
    });

    res.json({ success: true, member });
  } catch (err) {
    console.error("❌ Error upserting member:", err);
    res.status(500).json({ success: false, error: "Failed to upsert member" });
  }
});

export default router;
