const path = require("path");
const fs = require("fs");
require("./config/branchScope"); // before any model is compiled
require("./config/baseCurrency");
require("mongoose").plugin(require("./utils/shopify/stockPlugin")); // Shopify inventory sync on stock changes
const express = require("express");
const cors = require("cors");
const auth = require("./middleware/auth");
const { permit, anyOf } = require("./utils/roles");
const errorHandler = require("./middleware/errorHandler");

const app = express();

app.disable("x-powered-by");
app.set("trust proxy", "loopback"); // nginx on the same server sets X-Forwarded-For
// The app and its API share one origin; other sites may not call the API from a browser.
const env = require("./config/env");
const origins = [env.APP_URL, env.APP_URL.replace("://", "://www.")];
app.use(cors({ origin: (o, cb) => cb(null, !o || origins.includes(o) ? o || false : false), exposedHeaders: ["X-Session-Token"] }));
// Security headers (OWASP ZAP baseline findings).
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' data: blob: https:",
  "connect-src 'self'",
  "media-src 'self' blob:",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "frame-src 'self' blob:",
  "object-src 'self' blob:",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");
app.use((req, res, next) => {
  res.set({
    "Content-Security-Policy": CSP,
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(self), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
    "Cross-Origin-Resource-Policy": "same-origin",
  });
  // API answers (orders, buyer data, labels) are never cached by browsers or proxies.
  if (req.path.startsWith("/api/")) res.set("Cache-Control", "no-store");
  next();
});
app.use("/api/shopify-webhook", express.raw({ type: "*/*", limit: "5mb" }), require("./routes/shopifyWebhook"));
// Meta (WhatsApp / Messenger / Instagram / Page comments) webhooks: the raw body is needed for the signature check.
app.use("/api/webhooks/meta", express.raw({ type: "*/*", limit: "5mb" }), require("./routes/metaWebhook"));
app.use("/api/inbox/conversations", express.json({ limit: "25mb" }));
app.use("/api/import", express.json({ limit: "80mb" }));
app.use(["/api/attachments", "/api/bill-scan", "/api/gst/returns/2b", "/api/seller-portal"], express.json({ limit: "15mb" }));
app.use("/api/amazon", express.json({ limit: "60mb" }));
app.use(express.json({ limit: "1mb" }));

app.get("/api/health", (req, res) => res.send({ ok: true }));
app.use("/api", require("./utils/audit").trail);
app.use("/api/auth", require("./routes/auth"));
// Public: Google OAuth redirect, email unsubscribe pages, signed media links for Meta.
app.use("/api/integrations", require("./routes/integrations").publicRouter);
app.use("/api/unsubscribe", express.urlencoded({ extended: false, limit: "10kb" }));
app.use("/api", require("./routes/publicMarketing"));
app.use("/api/integrations", auth, permit("marketing"), require("./routes/integrations"));
app.use("/api/inbox", auth, permit("inbox"), require("./routes/inbox"));
app.use("/api/marketing", auth, permit((req) => require("./routes/marketing").moduleOf(req)), require("./routes/marketing"));
app.use("/api/organization", auth, permit("settings", { readAll: true }), require("./routes/organization"));
app.use("/api/customers", auth, permit((req) => (req.method === "GET" ? anyOf("sales") : "sales.customers")), require("./routes/customers"));
app.use("/api/items", auth, permit((req) => (req.method === "GET" ? anyOf("items") : "items.items"), { readAll: true }), require("./routes/items"));
app.use("/api/inventory-adjustments", auth, permit("items.adjustments"), require("./routes/inventoryAdjustments"));
app.use("/api/recurring", auth, permit((req) => { const k = req.body?.kind || req.query.kind; return k === "invoice" ? "sales.recurring" : k ? "purchases.recurring" : ["sales.recurring", "purchases.recurring"]; }), require("./routes/recurring"));
app.use("/api/projects", auth, permit("sales.projects"), require("./routes/projects"));
app.use("/api/time-entries", auth, permit("sales.projects"), require("./routes/timeEntries"));
app.use("/api/gst", auth, permit("gst"), require("./routes/gst"));
app.use("/api/invoices", auth, permit((req) => (req.method === "GET" ? ["sales.invoices", "sales.payments", "sales.credit_notes", "sales.ledgers", "sales.recurring"] : "sales.invoices")), require("./routes/invoices"));
app.use("/api/quotes", auth, permit((req) => (req.method === "GET" ? ["sales.quotes", "sales.sales_orders", "sales.invoices"] : "sales.quotes")), require("./routes/quotes"));
app.use("/api/sales-orders", auth, permit((req) => (req.method === "GET" ? ["sales.sales_orders", "sales.invoices"] : "sales.sales_orders")), require("./routes/salesOrders"));
app.use("/api/credit-notes", auth, permit((req) => (req.method === "GET" ? ["sales.credit_notes", "sales.payments"] : "sales.credit_notes")), require("./routes/creditNotes"));
app.use("/api/vendors", auth, permit((req) => (req.method === "GET" ? anyOf("purchases") : "purchases.vendors")), require("./routes/vendors"));
app.use("/api/bills", auth, permit((req) => (req.method === "GET" ? ["purchases.bills", "purchases.payments_made", "purchases.vendor_credits", "purchases.ledgers", "purchases.recurring"] : "purchases.bills")), require("./routes/bills"));
app.use("/api/vendor-payments", auth, permit("purchases.payments_made"), require("./routes/vendorPayments"));
app.use("/api/expenses", auth, permit((req) => (req.method === "GET" ? ["purchases.expenses", "purchases.ledgers", "purchases.recurring"] : "purchases.expenses")), require("./routes/expenses"));
app.use("/api/purchase-orders", auth, permit((req) => (req.method === "GET" ? ["purchases.purchase_orders", "purchases.bills"] : "purchases.purchase_orders")), require("./routes/purchaseOrders"));
app.use("/api/vendor-credits", auth, permit((req) => (req.method === "GET" ? ["purchases.vendor_credits", "purchases.payments_made"] : "purchases.vendor_credits")), require("./routes/vendorCredits"));
app.use("/api/bank-rules", auth, permit("banking"), require("./routes/bankRules"));
app.use("/api/banking", auth, permit((req) => (req.method === "GET" && req.path === "/accounts" ? [...anyOf("sales"), ...anyOf("purchases"), "banking", ...anyOf("accountant"), "store_orders", "settings"] : "banking")), require("./routes/banking"));
app.use("/api/accounts", auth, permit((req) => (req.method === "GET" ? anyOf("accountant") : "accountant.accounts"), { readAll: true }), require("./routes/accounts"));
app.use("/api/journals", auth, permit("accountant.journals"), require("./routes/journals"));
app.use("/api/budgets", auth, permit("accountant.budgets"), require("./config/baseCurrency").inBase, require("./config/branchScope").scopeByBranch, require("./routes/budgets"));
app.use("/api/fixed-assets", auth, permit("accountant.fixed_assets"), require("./routes/fixedAssets"));
app.use("/api/reports", auth, permit("reports"), require("./config/baseCurrency").inBase, require("./config/branchScope").scopeByBranch, require("./routes/reports"));
app.use("/api/payments", auth, permit("sales.payments"), require("./routes/payments"));
app.use("/api/documents", auth, permit((req) => require("./routes/documents").moduleOf(req)), require("./routes/documents"));
app.use("/api/branches", auth, permit("settings", { readAll: true }), require("./routes/branches"));
app.use("/api/warehouses", auth, permit((req) => (req.method === "GET" ? anyOf("items") : "items.items"), { readAll: true }), require("./routes/warehouses"));
app.use("/api/transfer-orders", auth, permit("items.transfer_orders"), require("./routes/transferOrders"));
app.use("/api/currencies", auth, permit("settings", { readAll: true }), require("./routes/currencies"));
app.use("/api/shopify", auth, permit((req) => require("./routes/shopify").moduleOf(req)), require("./routes/shopify"));
app.use("/api/stock", auth, permit("inventory"), require("./routes/stock"));
app.use("/api/import", auth, permit("settings"), require("./routes/import"));
app.use("/api/users", auth, permit("settings"), require("./routes/users"));
app.use("/api/roles", auth, permit("settings"), require("./routes/roles"));
app.use("/api/companies", auth, require("./routes/companies"));
app.use("/api/security", auth, require("./routes/security"));
app.use("/api/superadmin", auth, require("./routes/superadmin"));
app.use("/api/sellers", auth, permit((req) => (req.method === "GET" && req.path === "/" ? ["store_sellers", "store_orders", "store_shipping"] : "store_sellers")), require("./routes/sellers"));
app.use("/api/seller-portal", auth, require("./routes/sellerPortal"));
app.use("/api/flipkart-orders", auth, permit((req) => require("./routes/flipkartOrders").moduleOf(req)), require("./routes/flipkartOrders"));
app.use("/api/amazon-orders", auth, permit((req) => require("./routes/amazonOrders").moduleOf(req)), require("./routes/amazonOrders"));
app.use("/api/amazon", auth, permit((req) => (req.method === "GET" ? ["sales.amazon", "gst"] : "sales.amazon")), require("./routes/amazon"));
app.use("/api/attachments", auth, require("./routes/attachments"));
app.use("/api/bill-scan", auth, permit("purchases.bills"), require("./routes/billScan"));
app.use("/api/dashboard", auth, permit(["sales", "purchases", "reports", "accountant", "banking"]), require("./config/baseCurrency").inBase, require("./routes/dashboard"));
app.use("/api", (req, res) => res.status(404).send({ message: "Not found" }));

// Serve the built React app (frontend/dist) in production.
const dist = path.join(__dirname, "..", "..", "frontend", "dist");
if (fs.existsSync(dist)) {
  // The service worker must always be fresh, or users would be stuck on an old version.
  app.get("/sw.js", (req, res) => res.set("Cache-Control", "no-cache").sendFile(path.join(dist, "sw.js")));
  app.use(express.static(dist, { index: false, maxAge: "1h" }));
  app.get("*", (req, res) => res.sendFile(path.join(dist, "index.html")));
}

app.use(errorHandler);

module.exports = app;
