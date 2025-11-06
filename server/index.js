// =============================================
// 🌍 Load environment variables FIRST
// =============================================
import dotenv from "dotenv";
import fs from "fs";
import path from "path";

const dbPath = process.env.DATABASE_URL?.replace("file:", "");
if (dbPath && !fs.existsSync(path.resolve(process.cwd(), dbPath))) {
  console.warn("⚠️  WARNING: Prisma DB file does not exist →", dbPath);
} else {
  console.log("✅ Prisma DB connected:", dbPath);
}

// ✅ Force load from this exact file
const envPath = path.resolve(process.cwd(), ".env");
dotenv.config({ path: envPath });

// 🧠 DEBUG: Confirm environment variables loaded correctly
console.log("🔑 Shopify Environment Check:");
console.log("   🧩 .env loaded from:", envPath);
console.log("   🧩 SHOPIFY_API_KEY:", process.env.SHOPIFY_API_KEY || "(missing)");
console.log("   🧩 SHOPIFY_API_SECRET:", process.env.SHOPIFY_API_SECRET ? "(set ✅)" : "(missing ❌)");
console.log("   🧩 SHOPIFY_SCOPES:", process.env.SHOPIFY_SCOPES || "(missing)");
console.log("   🧩 SHOPIFY_API_VERSION:", process.env.SHOPIFY_API_VERSION || "(missing)");
console.log("   🧩 APP_URL:", process.env.APP_URL || "(missing)");
console.log("   🧩 DATABASE_URL:", process.env.DATABASE_URL || "(missing)");
console.log("----------------------------------------------------");

// 🧠 Debug — show exactly what file Node is reading
console.log("🧩 Loaded from:", envPath);

if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, "utf8");
  console.log("📄 .env file contents:\n" + envContent);
} else {
  console.log("⚠️ .env file not found at:", envPath);
}

console.log("🧩 Loaded SHOPIFY_API_KEY:", process.env.SHOPIFY_API_KEY);

// =============================================
// 🧠 Imports (after env setup)
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

// =============================================
// 🚀 Server Setup
// =============================================
console.log("🧠 Starting ProCircle server setup...");

const app = express();
const PORT = process.env.PORT || 3001;

// ✅ Middleware
app.use(cookieParser());
app.set("trust proxy", 1);

// ✅ Session
app.use(
  session({
    name: "shopify_app_session",
    secret: process.env.JWT_SECRET || "supersecretstring",
    resave: false,
    saveUninitialized: false,
    proxy: true,
    cookie: {
      secure: true, // ✅ required for SameSite=None
      sameSite: "none", // ✅ allows cookies across ngrok <-> Shopify
      httpOnly: true,
      maxAge: 600000, // 10 min session for OAuth
    },
  })
);

// ✅ Parse JSON for everything *except* Shopify webhooks
app.use((req, res, next) => {
  if (req.originalUrl.startsWith("/api/webhooks")) {
    next(); // skip JSON parsing for webhooks
  } else {
    express.json()(req, res, next);
  }
});

// =============================================
// 🛍️ Shopify API Setup
// =============================================
const shopify = shopifyApi({
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
app.use("/", authRoutes);
app.use("/api/discounts", discountRoutes);
app.use("/api/webhooks", webhookRoutes);
app.use("/api/settings", settingsRouter);

// =============================================
// 🌟 Root route — Shopify-friendly setup page
// =============================================
app.get("/", (req, res) => {
  const shop =
    req.query.shop ||
    req.get("X-Shopify-Shop-Domain") ||
    "your-dev-store.myshopify.com";

  const authUrl = `${process.env.APP_URL}/auth?shop=${shop}`;

  res.send(`
    <html>
      <head>
        <title>ProCircle App Setup</title>
        <style>
          body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            text-align: center;
            padding: 60px;
            background-color: #f6f6f7;
            color: #202223;
          }
          h1 {
            font-size: 26px;
            margin-bottom: 20px;
          }
          p {
            font-size: 16px;
            margin-bottom: 30px;
          }
          a {
            display: inline-block;
            background: #008060;
            color: white;
            text-decoration: none;
            font-weight: 600;
            padding: 12px 28px;
            border-radius: 6px;
            transition: background 0.3s ease;
          }
          a:hover {
            background: #004c3f;
          }
        </style>
      </head>
      <body>
        <h1>🚀 Welcome to ProCircle</h1>
        <p>Click below to complete setup for your Shopify store.</p>
        <a href="${authUrl}" target="_top">Complete Installation</a>
        <p style="margin-top:40px;font-size:14px;color:#6d7175;">If you’ve already installed, click the app again from your Shopify admin.</p>
      </body>
    </html>
  `);
});

// =============================================
// ✅ Start server
// =============================================
console.log("🚀 About to start Express server...");
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ ProCircle server running on http://localhost:${PORT}`);
});