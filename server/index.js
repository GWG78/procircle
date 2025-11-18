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
<script src="https://unpkg.com/@shopify/app-bridge@3"></script>

<style>
  body {
    margin: 0;
    padding: 0;
    font-family: -apple-system, BlinkMacSystemFont, "San Francisco",
      "Helvetica Neue", sans-serif;
    background: #f6f6f7;
  }

  .App { min-height: 100vh; padding: 24px; display:flex; justify-content:center; }
  .Card {
    background: #fff;
    border-radius: 12px;
    padding: 24px;
    width: 100%;
    max-width: 960px;
    box-shadow: 0 1px 3px rgba(0,0,0,0.08);
  }
  .Title { font-size: 20px; font-weight: 600; margin-bottom:4px; }
  .Subtitle { color:#6d7175; margin-bottom:16px; }
  .Grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(260px,1fr)); gap:24px; }
  .SectionLabel { font-size:13px; text-transform:uppercase; color:#8c9196; margin-bottom:8px; }
  .Field { margin-bottom:12px; }
  .Field label { font-size:14px; font-weight:500; margin-bottom:4px; display:block; }
  .Field small { font-size:11px; color:#8c9196; }
  input, select {
    width:100%; padding:6px 8px; border-radius:4px;
    border:1px solid #c9cccf; font-size:14px;
  }
  select[multiple] { min-height:120px; }
  .CheckboxGroup label { display:block; margin:4px 0; }
  .ButtonRow { margin-top:16px; display:flex; gap:8px; }
  .Button { padding:8px 14px; border:none; border-radius:6px; cursor:pointer; }
  .Button-primary { background:#008060; color:white; }
  .Button-secondary { background:#f6f6f7; color:#202223; }
  .Toast {
    position:fixed; bottom:16px; right:16px;
    padding:10px 14px; border-radius:999px; font-size:13px;
    background:#111827; color:white; display:none;
  }
  .Toast--show { display:inline-flex; }
</style>
</head>

<body>
<div class="App">
<div class="Card">

<h1 class="Title">ProCircle settings</h1>
<p class="Subtitle">Control who can claim discounts and how your codes are generated.</p>

<div class="Grid">

  <!-- LEFT -->
  <div>
    <div class="SectionLabel">Discount rules</div>

    <div class="Field">
      <label for="discountType">Discount type</label>
      <select id="discountType">
        <option value="percentage">Percentage (%)</option>
        <option value="fixed">Fixed amount</option>
      </select>
    </div>

    <div class="Field">
      <label for="discountValue">Discount value</label>
      <input id="discountValue" type="number" min="1" />
    </div>

    <div class="Field">
      <label for="expiryDays">Expiry window (days)</label>
      <input id="expiryDays" type="number" min="1" />
    </div>

    <div class="Field">
      <label for="maxDiscounts">Max number of codes</label>
      <input id="maxDiscounts" type="number" min="1" />
    </div>

    <label style="display:flex; align-items:center; gap:8px;">
      <input id="oneTimeUse" type="checkbox" checked />
      One-time use per code
    </label>
  </div>

  <!-- RIGHT -->
  <div>
    <div class="SectionLabel">Allowed Countries</div>
    <div class="CheckboxGroup">
      <label><input type="checkbox" name="allowedCountries" value="UK"> United Kingdom</label>
      <label><input type="checkbox" name="allowedCountries" value="CH"> Switzerland</label>
      <label><input type="checkbox" name="allowedCountries" value="FR"> France</label>
      <label><input type="checkbox" name="allowedCountries" value="IT"> Italy</label>
      <label><input type="checkbox" name="allowedCountries" value="DE"> Germany</label>
      <label><input type="checkbox" name="allowedCountries" value="AT"> Austria</label>
    </div>

    <div class="SectionLabel" style="margin-top:20px;">Allowed Member Types</div>
    <div class="CheckboxGroup">
      <label><input type="checkbox" name="allowedMemberTypes" value="instructor"> Instructor</label>
      <label><input type="checkbox" name="allowedMemberTypes" value="club_member"> Club Member</label>
      <label><input type="checkbox" name="allowedMemberTypes" value="competitor"> Competition Racer</label>
      <label><input type="checkbox" name="allowedMemberTypes" value="mountain_guide"> Mountain Guide</label>
    </div>

    <div class="Field" style="margin-top:20px;">
      <label for="categories">Collections (Shopify)</label>
      <select id="categories" multiple></select>
    </div>
  </div>

</div>

<div class="ButtonRow">
  <button class="Button Button-primary" id="saveSettings">Save settings</button>
  <button class="Button Button-secondary" id="openSheet">Open Google Sheet</button>
  <button class="Button Button-secondary" id="openDocs">View setup guide</button>
</div>

</div>
</div>

<div id="toast" class="Toast"></div>

<script>
(function() {
  const shop = new URLSearchParams(window.location.search).get("shop");

  const AppBridge = window["app-bridge"];
  const app = AppBridge.createApp({
    apiKey: "${process.env.SHOPIFY_API_KEY}",
    host: new URLSearchParams(location.search).get("host"),
    forceRedirect: true,
  });

  const Redirect = AppBridge.actions.Redirect.create(app);

  const toast = document.getElementById("toast");
  function showToast(msg, error=false) {
    toast.textContent = msg;
    toast.style.background = error ? "#b91c1c" : "#111827";
    toast.classList.add("Toast--show");
    setTimeout(()=>toast.classList.remove("Toast--show"), 3000);
  }

  function getChecked(name) {
    return Array.from(document.querySelectorAll('input[name="'+name+'"]:checked'))
      .map(cb => cb.value);
  }

  function setChecked(name, values=[]) {
    const v = new Set(values);
    document.querySelectorAll('input[name="'+name+'"]').forEach(cb => {
      cb.checked = v.has(cb.value);
    });
  }

  const discountTypeEl = document.getElementById("discountType");
  const discountValueEl = document.getElementById("discountValue");
  const expiryDaysEl = document.getElementById("expiryDays");
  const maxDiscountsEl = document.getElementById("maxDiscounts");
  const oneTimeUseEl = document.getElementById("oneTimeUse");
  const categoriesEl = document.getElementById("categories");

  async function loadCollections(selected=[]) {
    const res = await fetch("/api/settings/collections?shop="+shop, { credentials:"include" });
    const data = await res.json();
    if (!data.success) return;

    categoriesEl.innerHTML = "";
    data.collections.forEach(c => {
      const opt = document.createElement("option");
      opt.value = c.handle;
      opt.textContent = c.title;
      categoriesEl.appendChild(opt);
    });

    const set = new Set(selected);
    Array.from(categoriesEl.options).forEach(opt => opt.selected = set.has(opt.value));
  }

  async function loadSettings() {
    const res = await fetch("/api/settings?shop="+shop, { credentials:"include" });
    const data = await res.json();

    const s = data.settings || {};
    discountTypeEl.value = s.discountType || "percentage";
    discountValueEl.value = s.discountValue ?? 20;
    expiryDaysEl.value = s.expiryDays ?? "";
    maxDiscountsEl.value = s.maxDiscounts ?? "";
    oneTimeUseEl.checked = s.oneTimeUse !== false;

    setChecked("allowedCountries", s.allowedCountries);
    setChecked("allowedMemberTypes", s.allowedMemberTypes);

    await loadCollections(s.categories || []);
  }

  document.getElementById("saveSettings").addEventListener("click", async () => {
    try {
      const payload = {
        discountType: discountTypeEl.value,
        discountValue: Number(discountValueEl.value),
        expiryDays: expiryDaysEl.value ? Number(expiryDaysEl.value) : null,
        maxDiscounts: maxDiscountsEl.value ? Number(maxDiscountsEl.value) : null,
        oneTimeUse: oneTimeUseEl.checked,
        allowedCountries: getChecked("allowedCountries"),
        allowedMemberTypes: getChecked("allowedMemberTypes"),
        categories: Array.from(categoriesEl.selectedOptions).map(o => o.value),
      };

      const res = await fetch("/api/settings?shop="+shop, {
        method:"POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(payload)
      });

      const data = await res.json();
      if (!data.success) return showToast("Failed to save settings", true);

      showToast("Settings saved!");
    } catch (e) {
      showToast("Error saving settings", true);
    }
  });

  document.getElementById("openDocs").addEventListener("click", () => {
    Redirect.dispatch(Redirect.Action.REMOTE, "https://procircle.io");
  });

  document.getElementById("openSheet").addEventListener("click", () => {
    Redirect.dispatch(Redirect.Action.REMOTE, "https://docs.google.com/spreadsheets/");
  });

  loadSettings();
})();
</script>

</body>
</html>
  `);
});

// =============================================
// 🚀 Start server
// =============================================
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ ProCircle server running on http://localhost:${PORT}`);
});