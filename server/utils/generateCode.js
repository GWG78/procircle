// utils/generateCode.js

export function generateDiscountCode(name) {
  // Initials
  const initials = name
    .split(" ")
    .filter(Boolean)
    .map(part => part[0].toUpperCase())
    .join("");

  // Random segment using Web Crypto API (works in Node 20+)
  const bytes = new Uint8Array(3);
  crypto.getRandomValues(bytes);

  const randomPart = Array.from(bytes)
    .map(b => b.toString(16).padStart(2, "0"))
    .join("")
    .substring(0, 4)
    .toUpperCase();

  return `PC-${initials}-${randomPart}`;
}