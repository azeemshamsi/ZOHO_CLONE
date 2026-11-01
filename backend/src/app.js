const path = require("path");
const fs = require("fs");
const express = require("express");
const cors = require("cors");
const auth = require("./middleware/auth");
const { permit } = require("./utils/roles");
const errorHandler = require("./middleware/errorHandler");

const app = express();

app.disable("x-powered-by");
app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.get("/api/health", (req, res) => res.send({ ok: true }));
app.use("/api/auth", require("./routes/auth"));
app.use("/api/organization", auth, permit("settings", { readAll: true }), require("./routes/organization"));
app.use("/api/customers", auth, permit("sales"), require("./routes/customers"));
app.use("/api/items", auth, permit("items", { readAll: true }), require("./routes/items"));
app.use("/api/inventory-adjustments", auth, permit("items"), require("./routes/inventoryAdjustments"));
app.use("/api/recurring", auth, permit((req) => { const k = req.body?.kind || req.query.kind; return k === "invoice" ? "sales" : k ? "purchases" : ["sales", "purchases"]; }), require("./routes/recurring"));
app.use("/api/projects", auth, permit("sales"), require("./routes/projects"));
app.use("/api/time-entries", auth, permit("sales"), require("./routes/timeEntries"));
app.use("/api/invoices", auth, permit("sales"), require("./routes/invoices"));
app.use("/api/quotes", auth, permit("sales"), require("./routes/quotes"));
app.use("/api/sales-orders", auth, permit("sales"), require("./routes/salesOrders"));
app.use("/api/credit-notes", auth, permit("sales"), require("./routes/creditNotes"));
app.use("/api/vendors", auth, permit("purchases"), require("./routes/vendors"));
app.use("/api/bills", auth, permit("purchases"), require("./routes/bills"));
app.use("/api/vendor-payments", auth, permit("purchases"), require("./routes/vendorPayments"));
app.use("/api/expenses", auth, permit("purchases"), require("./routes/expenses"));
app.use("/api/purchase-orders", auth, permit("purchases"), require("./routes/purchaseOrders"));
app.use("/api/vendor-credits", auth, permit("purchases"), require("./routes/vendorCredits"));
app.use("/api/bank-rules", auth, permit("banking"), require("./routes/bankRules"));
app.use("/api/banking", auth, permit((req) => (req.method === "GET" && req.path === "/accounts" ? null : "banking")), require("./routes/banking"));
app.use("/api/accounts", auth, permit("accountant", { readAll: true }), require("./routes/accounts"));
app.use("/api/journals", auth, permit("accountant"), require("./routes/journals"));
app.use("/api/budgets", auth, permit("accountant"), require("./routes/budgets"));
app.use("/api/reports", auth, permit("reports"), require("./routes/reports"));
app.use("/api/payments", auth, permit("sales"), require("./routes/payments"));
app.use("/api/documents", auth, permit((req) => require("./routes/documents").moduleOf(req)), require("./routes/documents"));
app.use("/api/users", auth, permit("settings"), require("./routes/users"));
app.use("/api/dashboard", auth, permit(null), require("./routes/dashboard"));
app.use("/api", (req, res) => res.status(404).send({ message: "Not found" }));

// Serve the built React app (frontend/dist) in production.
const dist = path.join(__dirname, "..", "..", "frontend", "dist");
if (fs.existsSync(dist)) {
  app.use(express.static(dist, { index: false, maxAge: "1h" }));
  app.get("*", (req, res) => res.sendFile(path.join(dist, "index.html")));
}

app.use(errorHandler);

module.exports = app;
