// server/routes/members.mjs
//
// Server-to-server endpoint for upserting Member rows — step 1 of the
// signup-bridge plan. Called by trusted backend callers only (Apps Script
// today, potentially WordPress later), never by end users directly, so it
// uses a shared-secret header rather than Shopify session auth.
import crypto from "node:crypto";
import express from "express";
import { PrismaClient } from "@prisma/client";
import { createWpUser, getWpPasswordResetLink } from "../services/wordpress.js";
import { logDataAccess } from "../utils/accessLog.js";

const prisma = new PrismaClient();
const router = express.Router();

const VERIFICATION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const VERIFY_REDIRECT_BASE = "https://procircle.io/verify/";

/**
 * ===========================================================
 * GET /api/members/verify?token=...
 *
 * Public — hit directly by a real member's browser via the link in their
 * verification email. Registered before the shared-secret middleware below
 * so it's exempt from it; that check is for trusted backend callers
 * (Apps Script), not browsers, which never send an x-api-key header.
 * ===========================================================
 */
router.get("/verify", async (req, res) => {
  const token = typeof req.query.token === "string" ? req.query.token.trim() : "";

  if (!token) {
    return res.redirect(`${VERIFY_REDIRECT_BASE}?status=invalid`);
  }

  try {
    const member = await prisma.member.findUnique({ where: { verificationToken: token } });

    if (!member) {
      return res.redirect(`${VERIFY_REDIRECT_BASE}?status=invalid`);
    }

    logDataAccess({
      action: 'READ',
      dataType: 'Member',
      shop: null,
      requestedBy: 'member-verification-link',
      recordCount: 1,
      fields: ['email', 'firstName', 'lastName', 'verificationToken', 'verificationTokenExpiresAt'],
    });

    if (!member.verificationTokenExpiresAt || member.verificationTokenExpiresAt < new Date()) {
      return res.redirect(`${VERIFY_REDIRECT_BASE}?status=expired`);
    }

    await prisma.member.update({
      where: { id: member.id },
      data: {
        verified: true,
        verifiedAt: new Date(),
        verificationToken: null,
        verificationTokenExpiresAt: null,
      },
    });

    logDataAccess({
      action: 'WRITE',
      dataType: 'Member',
      shop: null,
      requestedBy: 'member-verification-link',
      recordCount: 1,
      fields: ['verified', 'verifiedAt', 'verificationToken', 'verificationTokenExpiresAt'],
    });

    // From here on, verification itself is already done — both WP steps
    // fail gracefully to the generic success page rather than surfacing an
    // error, since a WP-side hiccup shouldn't make a successfully-verified
    // member think their verification failed.
    const wpUser = await createWpUser(member.email, member.firstName || "", member.lastName || "");

    if (!wpUser.success) {
      console.error("❌ WP user creation failed:", wpUser.error);
      return res.redirect(`${VERIFY_REDIRECT_BASE}?status=success`);
    }

    const resetResult = await getWpPasswordResetLink(member.email);

    if (!resetResult.success) {
      console.error("❌ WP reset link failed:", resetResult.error);
      return res.redirect(`${VERIFY_REDIRECT_BASE}?status=success`);
    }

    return res.redirect(resetResult.resetLink);
  } catch (err) {
    console.error("❌ Error verifying member:", err);
    return res.redirect(`${VERIFY_REDIRECT_BASE}?status=invalid`);
  }
});

// Shared-secret check, reusing GOOGLE_SHEET_SECRET — the same env var (and
// the same x-api-key header pattern) the old, now-deleted discounts.mjs
// used for its Google Sheets caller. Left unused since that route was
// deleted; repurposed here rather than introducing a new secret. Only
// applies to routes registered after this point (POST / below) — GET
// /verify above is deliberately registered first so it's unaffected.
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
 * syncs profile data; leaving those fields out of both the create default
 * and the update data means an update never resets an already-verified
 * member back to unverified.
 *
 * After the upsert, issues a verification token for members who aren't
 * verified yet and don't already hold a still-valid one — see the inline
 * logic below. Callers (Apps Script's MemberSync.js) are expected to email
 * this token as a link to GET /api/members/verify?token=...
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

    let member = await prisma.member.upsert({
      where: { email: cleanEmail },
      update: data,
      create: { email: cleanEmail, ...data },
    });

    logDataAccess({
      action: 'WRITE',
      dataType: 'Member',
      shop: null,
      requestedBy: 'apps-script',
      recordCount: 1,
      fields: ['email', 'firstName', 'lastName', 'role', 'country', 'resort'],
    });

    const now = new Date();
    const tokenExpired = !member.verificationTokenExpiresAt || member.verificationTokenExpiresAt < now;

    let verificationToken = null;

    if (!member.verified && (!member.verificationToken || tokenExpired)) {
      verificationToken = crypto.randomBytes(32).toString("hex");
      member = await prisma.member.update({
        where: { id: member.id },
        data: {
          verificationToken,
          verificationTokenExpiresAt: new Date(now.getTime() + VERIFICATION_TOKEN_TTL_MS),
        },
      });

      logDataAccess({
        action: 'WRITE',
        dataType: 'Member',
        shop: null,
        requestedBy: 'apps-script',
        recordCount: 1,
        fields: ['verificationToken', 'verificationTokenExpiresAt'],
      });
    } else if (!member.verified) {
      // Not verified, but already holds an unexpired token from a previous
      // sync call — reuse it rather than silently invalidating a link that
      // might already be sitting in the member's inbox.
      verificationToken = member.verificationToken;
    }

    res.json({ success: true, member, verificationToken });
  } catch (err) {
    console.error("❌ Error upserting member:", err);
    res.status(500).json({ success: false, error: "Failed to upsert member" });
  }
});

export default router;
