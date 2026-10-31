const path = require("path");
const fs = require("fs");
const express = require("express");
const cors = require("cors");
const auth = require("./middleware/auth");
const errorHandler = require("./middleware/errorHandler");

const app = express();

app.disable("x-powered-by");
app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.get("/api/health", (req, res) => res.send({ ok: true }));
app.use("/api/auth", require("./routes/auth"));
app.use("/api/organization", auth, require("./routes/organization"));
app.use("/api/customers", auth, require("./routes/customers"));
app.use("/api/items", auth, require("./routes/items"));
app.use("/api/invoices", auth, require("./routes/invoices"));
app.use("/api/quotes", auth, require("./routes/quotes"));
app.use("/api/sales-orders", auth, require("./routes/salesOrders"));
app.use("/api/credit-notes", auth, require("./routes/creditNotes"));
app.use("/api/vendors", auth, require("./routes/vendors"));
app.use("/api/bills", auth, require("./routes/bills"));
app.use("/api/vendor-payments", auth, require("./routes/vendorPayments"));
app.use("/api/expenses", auth, require("./routes/expenses"));
app.use("/api/purchase-orders", auth, require("./routes/purchaseOrders"));
app.use("/api/vendor-credits", auth, require("./routes/vendorCredits"));
app.use("/api/banking", auth, require("./routes/banking"));
app.use("/api/accounts", auth, require("./routes/accounts"));
app.use("/api/journals", auth, require("./routes/journals"));
app.use("/api/reports", auth, require("./routes/reports"));
app.use("/api/payments", auth, require("./routes/payments"));
app.use("/api/dashboard", auth, require("./routes/dashboard"));
app.use("/api", (req, res) => res.status(404).send({ message: "Not found" }));

// Serve the built React app (frontend/dist) in production.
const dist = path.join(__dirname, "..", "..", "frontend", "dist");
if (fs.existsSync(dist)) {
  app.use(express.static(dist, { index: false, maxAge: "1h" }));
  app.get("*", (req, res) => res.sendFile(path.join(dist, "index.html")));
}

app.use(errorHandler);

module.exports = app;
