console.log("🚨 INDEX.JS VERSION 2025-01-ENSURE-REMOVED");
// =============================================
// 🌍 Load environment variables
// =============================================
import dotenv from "dotenv";
dotenv.config();

console.log("🔑 API KEY:", process.env.SHOPIFY_API_KEY?.slice(0, 6));
console.log("🔑 API SECRET:", process.env.SHOPIFY_API_SECRET ? "SET" : "MISSING");

// =============================================
// 🧠 Imports
// =============================================
import express from "express";
import cookieParser from "cookie-parser";
import session from "express-session";

import "@shopify/shopify-api/adapters/node";

import authRoutes from "./auth.mjs";
import discountRoutes from "./routes/discounts.mjs";
import webhookRoutes from "./routes/webhooks.mjs";
import settingsRouter from "./routes/settings.mjs";

import fs from "fs";
import path from "path";

import { shopify } from "./shopify.js";

import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

// =============================================
// 🚀 Server Setup
// =============================================
const app = express();

// 🚨 MUST COME FIRST (before cookies/sessions)
app.set("trust proxy", true);

const PORT = process.env.PORT || 3001;

console.log("🔧 Loading index.js");

// CORS for Shopify Admin iframe
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "https://admin.shopify.com");
  res.header("Access-Control-Allow-Credentials", "true");
  res.header("Access-Control-Allow-Headers", "Content-Type, X-Requested-With");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");

  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

app.use(cookieParser());

prisma.$connect()
  .then(() => console.log("✅ Prisma connected"))
  .catch((e) => console.error("❌ Prisma failed to connect", e));

// =============================================
// 🧠 Session (embedded app requirement)
// =============================================
app.use(
  session({
    name: "shopify_app_session",
    secret: process.env.JWT_SECRET || "supersecretstring",
    resave: false,
    saveUninitialized: false,
    proxy: true,
    cookie: {
      secure: true,
      sameSite: "none",
      httpOnly: true,
    },
  })
);

// JSON parsing (skip webhooks)
app.use((req, res, next) => {
  if (req.originalUrl.startsWith("/api/webhooks")) return next();
  express.json()(req, res, next);
});

app.get("/__db_test", async (req, res) => {
  try {
    const count = await prisma.shop.count();
    res.json({ ok: true, shopCount: count });
  } catch (err) {
    console.error("❌ DB TEST FAILED:", err);
    res.status(500).json({
      ok: false,
      error: err.message,
    });
  }
});

// =============================================
// 🧩 ROUTES
// =============================================
console.log("🔧 Mounting auth routes…");
app.use("/", authRoutes);
console.log("🔧 Auth routes mounted!");

app.use("/api/discounts", discountRoutes);
app.use("/api/webhooks", webhookRoutes);
app.use("/api/settings", settingsRouter);

// =============================================
// 🌟 Embedded App Root
// =============================================

app.get("/", async (req, res) => {
  const shop = req.query.shop || "";

  const htmlPath = path.join(process.cwd(), "views/dashboard.html");
  let html = fs.readFileSync(htmlPath, "utf8");

  html = html.replace(
    `data-api-key=""`,
    `data-api-key="${process.env.SHOPIFY_API_KEY}"`
  );

  const installed = shop
    ? await prisma.shop.findUnique({
        where: { shopDomain: shop },
        select: { installed: true },
      })
    : null;

  html = html.replace(
    "</body>",
    `<script>window.__PROCIRCLE_INSTALLED__ = ${installed?.installed === true};</script></body>`
  );

  res.status(200).send(html);
});

// =============================================
// 🚀 Start server
// =============================================
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ ProCircle server running on http://localhost:${PORT}`);
});