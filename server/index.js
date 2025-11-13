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
app.use("/auth", authRoutes);
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
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <title>ProCircle Dashboard</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />

        <!-- Shopify App Bridge v3 -->
        <script src="https://unpkg.com/@shopify/app-bridge@3"></script>

        <!-- Polaris CSS (optional but nice) -->
        <link
          rel="stylesheet"
          href="https://unpkg.com/@shopify/polaris@12.7.0/build/esm/styles.css"
        />
        <style>
          body {
            margin: 0;
            padding: 0;
            font-family: -apple-system, BlinkMacSystemFont, "San Francisco",
              "Helvetica Neue", sans-serif;
            background: #f6f6f7;
          }

          .App {
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
          }

          .Card {
            background: #fff;
            border-radius: 12px;
            padding: 24px;
            max-width: 640px;
            width: 100%;
            box-shadow: 0 1px 3px rgba(0,0,0,0.08);
          }

          .Title {
            font-size: 20px;
            font-weight: 600;
            margin: 0 0 8px;
          }

          .Subtitle {
            color: #6d7175;
            margin: 0 0 16px;
          }

          .SectionLabel {
            font-size: 13px;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.04em;
            color: #8c9196;
            margin-bottom: 8px;
          }

          .Row {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 8px;
          }

          .Tag {
            display: inline-flex;
            align-items: center;
            padding: 2px 8px;
            border-radius: 999px;
            font-size: 12px;
            background: #e3f1df;
            color: #285c2a;
          }

          .ButtonRow {
            display: flex;
            margin-top: 16px;
            gap: 8px;
          }

          .Button {
            padding: 8px 14px;
            border-radius: 6px;
            border: none;
            cursor: pointer;
            font-size: 14px;
          }

          .Button-primary {
            background: #008060;
            color: #fff;
          }

          .Button-secondary {
            background: #f6f6f7;
            color: #202223;
          }

          .Small {
            font-size: 12px;
            color: #8c9196;
            margin-top: 12px;
          }
        </style>
      </head>
      <body>
        <div class="App">
          <div class="Card">
            <h1 class="Title">ProCircle is connected ✅</h1>
            <p class="Subtitle">
              Your store is now ready to generate Google Sheets–powered discount codes.
            </p>

            <div class="Section">
              <div class="SectionLabel">Store</div>
              <div class="Row">
                <div>${shop || "Your Shopify store"}</div>
                <span class="Tag">Live</span>
              </div>
            </div>

            <div class="Section" style="margin-top:16px;">
              <div class="SectionLabel">Discount engine</div>
              <p class="Small">
                Discounts are created via your Google Sheet using the ProCircle script.
                New rows in <strong>Users</strong> will automatically create codes in
                <strong>Codes</strong>.
              </p>
            </div>

            <div class="ButtonRow">
              <button class="Button Button-primary" id="openDocs">
                View setup guide
              </button>
              <button class="Button Button-secondary" id="openSheet">
                Open Google Sheet
              </button>
            </div>

            <div class="Small">
              Don&apos;t see codes? Make sure the Apps Script trigger
              is running and your API key matches the one in ProCircle.
            </div>
          </div>
        </div>

        <script>
          (function() {
            const AppBridge = window["app-bridge"];
            if (!AppBridge) {
              console.error("App Bridge not loaded");
              return;
            }

            const createApp = AppBridge.createApp;

            const app = createApp({
              apiKey: "${process.env.SHOPIFY_API_KEY}",
              host: new URLSearchParams(window.location.search).get("host"),
              forceRedirect: true,
            });

            const actions = AppBridge.actions;
            const Redirect = actions.Redirect.create(app);

            // Open docs (placeholder – swap with your real docs URL later)
            document.getElementById("openDocs").addEventListener("click", () => {
              Redirect.dispatch(
                Redirect.Action.REMOTE,
                "https://procircle.io" // or your Notion/docs URL
              );
            });

            // Open Google Sheet (placeholder – drop in your real sheet link)
            document.getElementById("openSheet").addEventListener("click", () => {
              Redirect.dispatch(
                Redirect.Action.REMOTE,
                "https://docs.google.com/spreadsheets/"
              );
            });
          })();
        </script>
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