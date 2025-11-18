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
import { shopifyApi } from "@shopify/shopify-api";
import { MemorySessionStorage } from "./memorySession.js";
import "@shopify/shopify-api/adapters/node";

import authRoutes from "./auth.mjs";
import discountRoutes from "./routes/discounts.mjs";
import webhookRoutes from "./routes/webhooks.mjs";
import settingsRouter from "./routes/settings.mjs";

import fs from "fs";
import path from "path";

// =============================================
// 🚀 Server Setup
// =============================================
const app = express();
const PORT = process.env.PORT || 3001;

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

// =============================================
// 🛍️ Shopify API Setup
// =============================================
shopifyApi({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET,
  scopes: process.env.SHOPIFY_SCOPES.split(","),
  hostName: process.env.APP_URL.replace(/https?:\/\//, ""),
  apiVersion: process.env.SHOPIFY_API_VERSION || "2024-07",
  isEmbeddedApp: true,
  sessionStorage: new MemorySessionStorage(),
});

// =============================================
// 🧩 Routes
// =============================================
app.use("/auth", authRoutes);
app.use("/api/discounts", discountRoutes);
app.use("/api/webhooks", webhookRoutes);
app.use("/api/settings", settingsRouter);

// =============================================
// 🌟 Embedded Shopify Dashboard (Root route)
// =============================================


app.get("/", (req, res) => {
  const shop = req.query.shop || req.get("X-Shopify-Shop-Domain") || "";
  const host = req.query.host || "";

  // Inject values into headers so dashboard.html can read them if needed
  res.setHeader("X-ProCircle-Shop", shop);
  res.setHeader("X-ProCircle-Host", host);

  // Load HTML template
  const htmlPath = path.join(process.cwd(), "server/views/dashboard.html");
  let html = fs.readFileSync(htmlPath, "utf8");

  // Inject API key into <script data-api-key="">
  html = html.replace(
    `data-api-key=""`,
    `data-api-key="${process.env.SHOPIFY_API_KEY}"`
  );

  // Send it
  res.send(html);
});

// =============================================
// 🚀 Start server
// =============================================
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ ProCircle server running on http://localhost:${PORT}`);
});