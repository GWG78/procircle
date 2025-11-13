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
// Root route — Embedded dashboard
app.get("/", (req, res) => {
  const shopParam =
    req.query.shop ||
    req.get("X-Shopify-Shop-Domain") ||
    "your-dev-store.myshopify.com";

  res.send(`
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <title>ProCircle Dashboard</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />

        <!-- Shopify App Bridge v3 -->
        <script src="https://unpkg.com/@shopify/app-bridge@3"></script>

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
            align-items: flex-start;
            justify-content: center;
            padding: 24px;
          }

          .Card {
            background: #fff;
            border-radius: 12px;
            padding: 24px;
            max-width: 960px;
            width: 100%;
            box-shadow: 0 1px 3px rgba(0,0,0,0.08);
          }

          .Title {
            font-size: 20px;
            font-weight: 600;
            margin: 0 0 4px;
          }

          .Subtitle {
            color: #6d7175;
            margin: 0 0 16px;
          }

          .Grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
            gap: 24px;
            margin-top: 16px;
          }

          .SectionLabel {
            font-size: 13px;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.04em;
            color: #8c9196;
            margin-bottom: 8px;
          }

          .Field {
            margin-bottom: 12px;
          }

          .Field label {
            display: block;
            font-size: 14px;
            font-weight: 500;
            margin-bottom: 4px;
          }

          .Field small {
            display: block;
            font-size: 11px;
            color: #8c9196;
          }

          input[type="text"],
          input[type="number"],
          select,
          textarea {
            width: 100%;
            box-sizing: border-box;
            padding: 6px 8px;
            border-radius: 4px;
            border: 1px solid #c9cccf;
            font-size: 14px;
          }

          select[multiple] {
            min-height: 120px;
          }

          .CheckboxRow {
            display: flex;
            align-items: center;
            gap: 8px;
            margin: 8px 0;
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

          .Badge {
            display: inline-block;
            font-size: 11px;
            padding: 2px 6px;
            border-radius: 999px;
            background: #f0f0f0;
            color: #5c5f62;
            margin-left: 4px;
          }

          .Toast {
            position: fixed;
            bottom: 16px;
            right: 16px;
            background: #111827;
            color: #fff;
            padding: 10px 14px;
            border-radius: 999px;
            font-size: 13px;
            display: none;
          }

          .Toast--show {
            display: inline-flex;
          }
        </style>
      </head>
      <body>
        <div class="App">
          <div class="Card">
            <h1 class="Title">ProCircle settings</h1>
            <p class="Subtitle">
              Control who can claim discounts and how your codes are generated
              from your Google Sheet.
            </p>

            <div class="Grid">
              <!-- LEFT: Discount parameters -->
              <div>
                <div class="SectionLabel">Discount rules</div>

                <div class="Field">
                  <label for="discountType">Discount type</label>
                  <select id="discountType">
                    <option value="percentage">Percentage (%)</option>
                    <option value="fixed">Fixed amount</option>
                  </select>
                  <small>How the discount should be applied at checkout.</small>
                </div>

                <div class="Field">
                  <label for="discountValue">Discount value</label>
                  <input id="discountValue" type="number" min="1" step="1" />
                  <small>For percentage, 20 = 20% off. For fixed, use your store currency.</small>
                </div>

                <div class="Field">
                  <label for="expiryDays">Expiry window (days)</label>
                  <input id="expiryDays" type="number" min="1" step="1" />
                  <small>How long codes are valid from creation. Leave blank for no expiry.</small>
                </div>

                <div class="Field">
                  <label for="maxDiscounts">Max number of codes</label>
                  <input id="maxDiscounts" type="number" min="1" step="1" />
                  <small>Optional. Cap total codes generated for this shop.</small>
                </div>

                <div class="CheckboxRow">
                  <input type="checkbox" id="oneTimeUse" checked />
                  <label for="oneTimeUse" style="margin:0;">One-time use per code</label>
                </div>
                <small class="Small">
                  We strongly recommend keeping this on so each member gets a unique single-use code.
                </small>
              </div>

              <!-- RIGHT: Eligibility filters -->
              <div>
                <div class="SectionLabel">Who can claim codes</div>

                <div class="Field">
                  <label for="allowedCountries">Countries</label>
                  <select id="allowedCountries" multiple>
                    <option value="CH">Switzerland</option>
                    <option value="FR">France</option>
                    <option value="IT">Italy</option>
                    <option value="DE">Germany</option>
                    <option value="AT">Austria</option>
                    <option value="UK">United Kingdom</option>
                  </select>
                  <small>Members outside these countries won’t see your offers.</small>
                </div>

                <div class="Field">
                  <label for="allowedMemberTypes">
                    Member type
                    <span class="Badge">Used as filters on your site</span>
                  </label>
                  <select id="allowedMemberTypes" multiple>
                    <option value="INSTRUCTOR">Instructors (ski & snowboard)</option>
                    <option value="CLUB_MEMBER">Ski & snowboard club members</option>
                    <option value="RACER">Race & competition athletes</option>
                    <option value="MOUNTAIN_GUIDE">Mountain & backcountry guides</option>
                  </select>
                  <small>
                    These map to your WordPress / Google Sheet filters so only eligible members see this brand.
                  </small>
                </div>

                <div class="Field">
                  <label for="categories">
                    Collections
                    <span class="Badge">From Shopify</span>
                  </label>
                  <select id="categories" multiple></select>
                  <small>
                    Choose which collections your ProCircle discounts should apply to.
                    If none are selected, we’ll fall back to your default discount config.
                  </small>
                </div>
              </div>
            </div>

            <div class="ButtonRow">
              <button class="Button Button-primary" id="saveSettings">
                Save settings
              </button>
              <button class="Button Button-secondary" id="openSheet">
                Open Google Sheet
              </button>
              <button class="Button Button-secondary" id="openDocs">
                View setup guide
              </button>
            </div>

            <div class="Small">
              These settings sync to your Google Sheet via the Apps Script,
              so your WordPress site knows which members can see each brand.
            </div>
          </div>
        </div>

        <div id="toast" class="Toast"></div>

        <script>
          (function() {
            const shopFromServer = ${JSON.stringify(shopParam)};
            const params = new URLSearchParams(window.location.search);
            const shop = params.get("shop") || shopFromServer;
            const host = params.get("host");

            const AppBridge = window["app-bridge"];
            if (!AppBridge) {
              console.error("App Bridge not loaded");
              return;
            }

            const createApp = AppBridge.createApp;
            const app = createApp({
              apiKey: "${process.env.SHOPIFY_API_KEY}",
              host,
              forceRedirect: true,
            });

            const actions = AppBridge.actions;
            const Redirect = actions.Redirect.create(app);

            const toastEl = document.getElementById("toast");
            function showToast(msg, isError) {
              toastEl.textContent = msg;
              toastEl.style.background = isError ? "#b91c1c" : "#111827";
              toastEl.classList.add("Toast--show");
              setTimeout(() => toastEl.classList.remove("Toast--show"), 3000);
            }

            const $ = (id) => document.getElementById(id);

            const discountTypeEl = $("discountType");
            const discountValueEl = $("discountValue");
            const expiryDaysEl = $("expiryDays");
            const maxDiscountsEl = $("maxDiscounts");
            const oneTimeUseEl = $("oneTimeUse");
            const allowedCountriesEl = $("allowedCountries");
            const allowedMemberTypesEl = $("allowedMemberTypes");
            const categoriesEl = $("categories");

            function getMultiSelectValues(selectEl) {
              return Array.from(selectEl.selectedOptions).map(o => o.value);
            }

            function setMultiSelectValues(selectEl, values) {
              const set = new Set(values || []);
              Array.from(selectEl.options).forEach(opt => {
                opt.selected = set.has(opt.value);
              });
            }

            // Load existing settings + collections
            async function loadSettings() {
              try {
                const base = "/api/settings";
                const query = shop ? "?shop=" + encodeURIComponent(shop) : "";
                const res = await fetch(base + query, {
                  credentials: "include",
                });
                const data = await res.json();
                if (!data.success) {
                  console.warn("Settings load warning:", data);
                }

                const s = data.settings || {};
                discountTypeEl.value = s.discountType || "percentage";
                discountValueEl.value = s.discountValue ?? 20;
                expiryDaysEl.value = s.expiryDays ?? "";
                maxDiscountsEl.value = s.maxDiscounts ?? "";
                oneTimeUseEl.checked =
                  typeof s.oneTimeUse === "boolean" ? s.oneTimeUse : true;

                setMultiSelectValues(allowedCountriesEl, s.allowedCountries);
                setMultiSelectValues(allowedMemberTypesEl, s.allowedMemberTypes);

                // Load collections and apply selected categories
                await loadCollections(s.categories || []);
              } catch (err) {
                console.error("Error loading settings:", err);
                showToast("Failed to load settings", true);
              }
            }

            async function loadCollections(selectedHandles) {
              try {
                const base = "/api/settings/collections";
                const query = shop ? "?shop=" + encodeURIComponent(shop) : "";
                const res = await fetch(base + query, {
                  credentials: "include",
                });
                const data = await res.json();
                if (!data.success) {
                  console.warn("Collections load warning:", data);
                  return;
                }

                const collections = data.collections || [];
                categoriesEl.innerHTML = "";

                collections.forEach((c) => {
                  const opt = document.createElement("option");
                  opt.value = c.handle;
                  opt.textContent = c.title || c.handle;
                  categoriesEl.appendChild(opt);
                });

                setMultiSelectValues(categoriesEl, selectedHandles);
              } catch (err) {
                console.error("Error loading collections:", err);
                showToast("Failed to load collections", true);
              }
            }

            // Save settings
            $("saveSettings").addEventListener("click", async () => {
              try {
                const payload = {
                  discountType: discountTypeEl.value,
                  discountValue: Number(discountValueEl.value),
                  expiryDays: expiryDaysEl.value
                    ? Number(expiryDaysEl.value)
                    : null,
                  maxDiscounts: maxDiscountsEl.value
                    ? Number(maxDiscountsEl.value)
                    : null,
                  oneTimeUse: oneTimeUseEl.checked,
                  allowedCountries: getMultiSelectValues(allowedCountriesEl),
                  allowedMemberTypes: getMultiSelectValues(allowedMemberTypesEl),
                  categories: getMultiSelectValues(categoriesEl),
                };

                const base = "/api/settings";
                const query = shop ? "?shop=" + encodeURIComponent(shop) : "";
                const res = await fetch(base + query, {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                  },
                  credentials: "include",
                  body: JSON.stringify(payload),
                });

                const data = await res.json();
                if (!data.success) {
                  showToast("Failed to save settings", true);
                  return;
                }

                showToast("Settings saved", false);
              } catch (err) {
                console.error("Error saving settings:", err);
                showToast("Error saving settings", true);
              }
            });

            // Open docs
            $("openDocs").addEventListener("click", () => {
              Redirect.dispatch(
                Redirect.Action.REMOTE,
                "https://procircle.io" // swap when docs are live
              );
            });

            // Open Google Sheet (your internal sheet)
            $("openSheet").addEventListener("click", () => {
              Redirect.dispatch(
                Redirect.Action.REMOTE,
                "https://docs.google.com/spreadsheets/"
              );
            });

            loadSettings();
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