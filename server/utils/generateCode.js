// server/utils/generateCode.js

export function generateDiscountCode(name) {
  const initials = name
    .split(" ")
    .filter(Boolean)
    .map(part => part[0].toUpperCase())
    .join("");

  const randomPart = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `PRC-${initials}-${randomPart}`;
}
