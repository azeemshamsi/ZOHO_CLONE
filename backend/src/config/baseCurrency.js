/**
 * Reports in the base currency (₹). While a report request runs, every document read from a model
 * that has an `exchangeRate` comes back with its money fields converted to ₹ (and exchangeRate 1).
 * The ledger and inventory engine read raw documents (`raw(...)`) and apply the rates themselves.
 */
const { AsyncLocalStorage } = require("async_hooks");
const mongoose = require("mongoose");

const store = new AsyncLocalStorage();
const MONEY = ["subTotal", "cgst", "sgst", "igst", "taxTotal", "shippingCharge", "adjustment", "total", "balance", "amountPaid", "creditsApplied", "amount", "unusedAmount"];
const LINE = ["rate", "amount", "cgst", "sgst", "igst"];
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

function convert(d) {
  if (!d || typeof d !== "object") return;
  const rate = Number(d.exchangeRate) || 1;
  if (rate === 1) return;
  for (const f of MONEY) if (typeof d[f] === "number") d[f] = r2(d[f] * rate);
  for (const l of d.lineItems || []) for (const f of LINE) if (typeof l[f] === "number") l[f] = r2(l[f] * rate);
  for (const k of ["allocations", "refunds", "applications", "creditsAppliedList"]) for (const a of d[k] || []) if (typeof a.amount === "number") a.amount = r2(a.amount * rate);
  d.originalRate = rate;
  d.exchangeRate = 1;
}

mongoose.plugin((schema) => {
  if (!schema.path("exchangeRate")) return;
  schema.post(["find", "findOne"], function (res) {
    const s = store.getStore();
    if (!s || !s.base || s.raw) return;
    (Array.isArray(res) ? res : [res]).forEach(convert);
  });
});

const inBase = (req, res, next) => store.run({ ...(store.getStore() || {}), base: true }, next);
// Run fn with raw (unconverted) documents.
const raw = (fn) => store.run({ ...(store.getStore() || {}), raw: true }, fn);

module.exports = { inBase, raw, store };
