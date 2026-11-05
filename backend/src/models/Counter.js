const mongoose = require("mongoose");

// Per-organization running numbers for invoices, payments, etc.
const counterSchema = new mongoose.Schema({
  organization: { type: mongoose.Schema.Types.ObjectId, required: true },
  key: { type: String, required: true },
  seq: { type: Number, default: 0 },
});
counterSchema.index({ organization: 1, key: 1 }, { unique: true });

const Counter = mongoose.model("Counter", counterSchema);

// Where each series' numbers live, so a new number continues after the highest one already used
// (including vouchers imported from Tally or entered by hand).
const SOURCES = {
  invoice: [["Invoice", "invoiceNumber"], ["Journal", "number"]], // Tally cash sales are journals in the invoice series
  creditNote: ["CreditNote", "number"],
  quote: ["Quote", "number"],
  salesOrder: ["SalesOrder", "number"],
  purchaseOrder: ["PurchaseOrder", "number"],
  vendorCredit: ["VendorCredit", "number"],
  payment: ["Payment", "paymentNumber"],
  vendorPayment: ["VendorPayment", "paymentNumber"],
  journal: ["Journal", "number"],
  fixedAsset: ["FixedAsset", "number"],
  inventoryAdjustment: ["InventoryAdjustment", "number"],
  transferOrder: ["TransferOrder", "number"],
};

// "SH/26-27/392" with prefix "SH/26-27/" → 392. Separators are ignored when comparing the prefix
// ("SH/26/27/" matches "SH/26-27/"), so numbers typed or imported with a slightly different
// punctuation still count. Anything else (another series, text after the number) doesn't.
const norm = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
function seqOf(number, prefix) {
  const m = String(number || "").trim().match(/^(.*?)(\d+)$/);
  if (!m || norm(m[1]) !== norm(prefix)) return 0;
  return Number(m[2]) || 0;
}

// Highest number used in the series (read in the app: regex queries are unreliable on the Oracle MongoDB API).
async function highestUsed(organization, key, prefix) {
  const src = SOURCES[String(key).split(":")[0]];
  if (!src) return 0;
  let max = 0;
  for (const [model, field] of Array.isArray(src[0]) ? src : [src]) {
    const Model = mongoose.models[model] || require(`./${model}`);
    const docs = await Model.find({ organization }, { [field]: 1 }).lean();
    for (const d of docs) max = Math.max(max, seqOf(d[field], prefix));
  }
  return max;
}

// Bring the counter up to the highest number used, then take the next one.
async function catchUp(organization, key, prefix) {
  const used = await highestUsed(organization, key, prefix).catch(() => 0);
  const c = await Counter.findOne({ organization, key });
  if (!c) {
    if (used) await Counter.create({ organization, key, seq: used }).catch(() => {});
  } else if (used > c.seq) await Counter.updateOne({ _id: c._id }, { $set: { seq: used } });
}

// Numbers are padded to 2 digits: INV-01 … INV-09, INV-10, INV-123.
async function nextNumber(organization, key, prefix, width = 2) {
  await catchUp(organization, key, prefix);
  const doc = await Counter.findOneAndUpdate({ organization, key }, { $inc: { seq: 1 } }, { new: true, upsert: true });
  return `${prefix}${String(doc.seq).padStart(width, "0")}`;
}

// The number the next document would get (shown on a new form), without using it up.
async function peekNext(organization, key, prefix, width = 2) {
  const [c, used] = await Promise.all([Counter.findOne({ organization, key }).lean(), highestUsed(organization, key, prefix).catch(() => 0)]);
  return `${prefix}${String(Math.max(c ? c.seq : 0, used) + 1).padStart(width, "0")}`;
}

module.exports = { Counter, nextNumber, peekNext, seqOf };
