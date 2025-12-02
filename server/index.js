// =============================================
// 🌍 Load environment variables
// =============================================
import dotenv from "dotenv";
dotenv.config();

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

// =============================================
// 🚀 Server Setup
// =============================================
const app = express();
const PORT = process.env.PORT || 3001;

console.log("🔧 Loading index.js");

app.use(cookieParser());
app.set("trust proxy", 1);

// Session (embedded app requirement)
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
      maxAge: 600000,
    },
  })
);

// JSON parsing (but skip raw for webhooks)
app.use((req, res, next) => {
  if (req.originalUrl.startsWith("/api/webhooks")) return next();
  express.json()(req, res, next);
});

console.log("🔧 Mounting auth routes…");
app.use("/", authRoutes);
console.log("🔧 Auth routes mounted!");

// =============================================
// 🧩 ROUTES
// =============================================

// 🔒 OAuth — MUST be mounted at /auth
app.use("/auth", authRoutes);

// Discount code API
app.use("/api/discounts", discountRoutes);

// Webhook receiver
app.use("/api/webhooks", webhookRoutes);

// Brand settings API
app.use("/api/settings", settingsRouter);

// =============================================
// 🌟 Embedded Shopify Dashboard (Root route)
// =============================================

app.get("/", (req, res) => {
  const shop = req.query.shop || req.get("X-Shopify-Shop-Domain") || "";
  const host = req.query.host || "";

  res.setHeader("X-ProCircle-Shop", shop);
  res.setHeader("X-ProCircle-Host", host);

  // Load HTML template
  const htmlPath = path.join(process.cwd(), "views/dashboard.html");
  let html = fs.readFileSync(htmlPath, "utf8");

  html = html.replace(
    `data-api-key=""`,
    `data-api-key="${process.env.SHOPIFY_API_KEY}"`
  );

  res.send(html);
});

// =============================================
// 🚀 Start server
// =============================================
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ ProCircle server running on http://localhost:${PORT}`);
});