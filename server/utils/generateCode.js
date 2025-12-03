
// utils/generateCode.js

/**
 * Clean, branded, collision-safe discount codes.
 * Format example: PC-WILSON-4F9D7C
 */

import crypto from "crypto";

// utils/generateCode.js
import crypto from "crypto";

export function generateDiscountCode(name = "") {
  // Extract initials (up to 3 to avoid huge blocks like 6+ initials)
  const initials = String(name)
    .trim()
    .split(/\s+/)
    .map(part => part[0]?.toUpperCase() || "")
    .join("")
    .substring(0, 3); // optional: keep initials short

  // Crypto-random 6-char hex (much safer than Math.random)
  const randomPart = crypto.randomBytes(3).toString("hex").toUpperCase();

  return `PRC-${initials || "XX"}-${randomPart}`;
}
