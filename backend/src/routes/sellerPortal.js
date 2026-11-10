/**
 * A marketplace seller's own dashboard (role "seller"): only their order lines, labels of shipments picked up from
 * them, their Shopify stock, their purchase orders and penalties. Mounted at /api/seller-portal.
 * Never returns other sellers' products, customers' phone / email, or our prices and accounts.
 */
const router = require("express").Router();
const Joi = require("joi");
const Seller = require("../models/Seller");
const SellerPenalty = require("../models/SellerPenalty");
const ShopifyOrder = require("../models/ShopifyOrder");
const ShopifyStore = require("../models/ShopifyStore");
const { ah, validate, HttpError } = require("../utils/http");
const S = require("../utils/sellers");

router.use(
  ah(async (req, res, next) => {
    const m = req.membership;
    if (!m || m.role !== "seller" || !m.seller) throw new HttpError(403, "This page is for marketplace sellers");
    const s = await Seller.findOne({ _id: m.seller, organization: m.organization });
    if (!s) throw new HttpError(403, "Your seller account wasn't found. Contact the marketplace.");
    if (!s.active) throw new HttpError(403, "Your seller account is inactive. Contact the marketplace.");
    req.seller = s;
    next();
  })
);

const OPEN = ["new", "packed", "ready_to_ship", "shipped"];
const STATUSES = ["new", "packed", "ready_to_ship", "shipped", "delivered", "rto", "return_created", "returned", "cancelled"];

// What the seller may see of an order.
function view(o, s, costs) {
  const brands = new Set(s.brands.map(S.norm));
  const lines = (o.lines || []).filter((l) => brands.has(S.norm(l.vendor)));
  const sh = o.shipment || {};
  const mine = String(sh.seller || "") === String(s._id) || (lines.length && lines.length === (o.lines || []).filter((l) => l.quantity > 0).length);
  const settled = (o.sellerSettled || []).find((x) => String(x.seller) === String(s._id));
  const value = lines.reduce((t, l) => t + S.lineValue(l), 0);
  return {
    _id: o._id,
    name: o.name,
    orderDate: o.orderDate,
    status: o.status,
    paymentMode: o.paymentMode,
    shipTo: { name: o.shippingAddress?.name || o.customer?.name || "", city: o.shippingAddress?.city || "", state: o.shippingAddress?.province || "", pincode: o.shippingAddress?.zip || "" },
    lines: lines.map((l) => ({ title: l.title, variantTitle: l.variantTitle, sku: l.sku, quantity: l.quantity, unitPrice: l.unitPrice, image: l.image, payout: S.linePurchase(s, l, costs) })),
    otherItems: (o.lines || []).filter((l) => l.quantity > 0).length - lines.filter((l) => l.quantity > 0).length,
    value: Math.round(value * 100) / 100,
    payout: Math.round(lines.reduce((t, l) => t + S.linePurchase(s, l, costs), 0) * 100) / 100,
    shipment: sh.awb ? { courierName: sh.courierName, awb: sh.awb, trackStatus: sh.trackStatus, trackingUrl: sh.trackingUrl, bookedAt: sh.bookedAt, fromYou: !!mine, events: (sh.events || []).slice(0, 10) } : null,
    deliveredAt: o.deliveredAt || null,
    settled: settled ? (settled.excluded ? { excluded: true } : { number: settled.number, amount: settled.amount, at: settled.at }) : null,
  };
}

router.get(
  "/me",
  ah(async (req, res) => {
    const s = req.seller;
    const orders = await ShopifyOrder.find({ organization: s.organization, sellers: s._id }, { status: 1, orderDate: 1, deliveredAt: 1, statusChangedAt: 1, sellerSettled: 1, lines: 1 }).lean();
    const counts = Object.fromEntries(STATUSES.map((k) => [k, 0]));
    for (const o of orders) counts[o.status] = (counts[o.status] || 0) + 1;
    const penalties = await SellerPenalty.find({ seller: s._id, purchaseOrder: { $exists: false } }, { amount: 1 }).lean();
    res.send({
      seller: { _id: s._id, name: s.name, brands: s.brands, rate: s.rate, contactName: s.contactName, email: s.email, phone: s.phone, gstin: s.gstin, pickup: s.pickup },
      counts: { ...counts, open: OPEN.reduce((t, k) => t + counts[k], 0), all: orders.length },
      penaltiesPending: Math.round(penalties.reduce((t, p) => t + p.amount, 0) * 100) / 100,
    });
  })
);

router.get(
  "/orders",
  ah(async (req, res) => {
    const s = req.seller;
    const q = req.query;
    const page = Math.max(1, Number(q.page) || 1);
    const limit = 30;
    let list = await ShopifyOrder.find({ organization: s.organization, sellers: s._id }).sort({ orderDate: -1 }).lean();
    if (q.status === "open") list = list.filter((o) => OPEN.includes(o.status));
    else if (q.status && q.status !== "all") list = list.filter((o) => o.status === q.status);
    if (q.from) list = list.filter((o) => new Date(o.orderDate) >= new Date(`${q.from}T00:00:00+05:30`));
    if (q.to) list = list.filter((o) => new Date(o.orderDate) <= new Date(`${q.to}T23:59:59+05:30`));
    const brands = new Set(s.brands.map(S.norm));
    const costs = await S.costsFor(s.organization, list.flatMap((o) => (o.lines || []).filter((l) => brands.has(S.norm(l.vendor)))));
    let rows = list.map((o) => view(o, s, costs));
    const words = String(q.q || "").trim().toLowerCase().replace(/^#/, "").split(/\s+/).filter(Boolean);
    if (words.length) rows = rows.filter((r) => words.every((w) => [r.name, r.shipTo.name, r.shipTo.city, r.shipTo.pincode, r.shipment?.awb, ...r.lines.flatMap((l) => [l.title, l.sku])].filter(Boolean).join(" ").toLowerCase().includes(w)));
    res.send({ rows: rows.slice((page - 1) * limit, page * limit), total: rows.length, page, limit });
  })
);

router.get(
  "/orders/:id/label",
  ah(async (req, res) => {
    const s = req.seller;
    const o = await ShopifyOrder.findOne({ _id: req.params.id, organization: s.organization, sellers: s._id }).select("+shipment.labelPdf");
    if (!o) throw new HttpError(404, "Order not found");
    if (!o.shipment?.awb) throw new HttpError(400, "Not booked yet. The marketplace books the courier; the label appears here after that.");
    if (!view(o.toObject(), s).shipment.fromYou) throw new HttpError(403, "This order ships from another location, not yours");
    await require("../utils/shopify/labelOut").sendLabel(res, o, { org: s.organization, storeOrg: s.organization, own: req.query.own === "1" });
  })
);

/* ---------- stock on Shopify ---------- */
const storeOf = async (s) => {
  const st = await ShopifyStore.findOne({ organization: s.organization });
  if (!st?.connected) throw new HttpError(400, "The marketplace's Shopify store isn't connected right now");
  return st;
};

router.get(
  "/products",
  ah(async (req, res) => {
    res.send(await S.sellerProducts(await storeOf(req.seller), req.seller, { after: req.query.after, q: req.query.q }));
  })
);

router.post(
  "/products/stock",
  ah(async (req, res) => {
    const d = validate(Joi.object({ variantId: Joi.string().required(), quantity: Joi.number().integer().min(0).max(1000000).required().label("Quantity") }), req.body);
    res.send(await S.setSellerStock(await storeOf(req.seller), req.seller, d.variantId, d.quantity));
  })
);

/* ---------- purchase orders and penalties ---------- */
async function myPos(s) {
  const PurchaseOrder = require("../models/PurchaseOrder");
  const vendorIds = Object.values(s.vendors || {});
  if (!vendorIds.length) return [];
  return PurchaseOrder.find({ vendor: { $in: vendorIds }, status: { $ne: "draft" } }).sort({ date: -1 }).lean();
}

// Where the seller's invoice stands: under review (draft bill), approved, paid.
async function billStates(pos) {
  const Bill = require("../models/Bill");
  const ids = pos.map((p) => p.bill).filter(Boolean);
  const bills = ids.length ? await Bill.find({ _id: { $in: ids } }, { status: 1, billNumber: 1, total: 1, balance: 1, date: 1 }) : [];
  return new Map(bills.map((b) => [String(b._id), b]));
}
const invoiceState = (p, b) => {
  if (p.status === "cancelled") return "cancelled";
  if (!b) return "awaiting_invoice";
  if (b.status === "draft") return "under_review";
  if (b.balance <= 0 || b.status === "paid") return "paid";
  if (b.balance < b.total) return "part_paid";
  return "approved";
};

router.get(
  "/purchase-orders",
  ah(async (req, res) => {
    const pos = await myPos(req.seller);
    const bills = await billStates(pos);
    res.send(
      pos.map((p) => {
        const b = p.bill ? bills.get(String(p.bill)) : null;
        return { _id: p._id, number: p.number, date: p.date, reference: p.reference, status: p.status, total: p.total, lines: p.lineItems.length, invoice: b ? { number: b.billNumber, date: b.date, total: b.total, paid: Math.round((b.total - b.balance) * 100) / 100 } : null, invoiceState: invoiceState(p, b) };
      })
    );
  })
);

// The seller's invoice against a purchase order: becomes a draft bill (with the file attached) in the buying
// company, for the accounts team to check and approve.
router.post(
  "/purchase-orders/:id/invoice",
  ah(async (req, res) => {
    const d = validate(
      Joi.object({
        invoiceNumber: Joi.string().trim().min(1).max(50).required().label("Invoice number"),
        invoiceDate: Joi.date().max("now").required().label("Invoice date"),
        amount: Joi.number().min(0).required().label("Invoice amount"),
        name: Joi.string().max(200).required().label("File"),
        type: Joi.string().valid("application/pdf", "image/jpeg", "image/png", "image/webp").required().messages({ "any.only": "Upload a PDF or a photo (JPG / PNG)" }),
        data: Joi.string().required().label("File"),
        note: Joi.string().allow("").max(500),
      }),
      req.body
    );
    const p = (await myPos(req.seller)).find((x) => String(x._id) === req.params.id);
    if (!p) throw new HttpError(404, "Purchase order not found");
    if (p.status === "cancelled") throw new HttpError(400, "This purchase order is cancelled");
    if (p.bill) throw new HttpError(400, "An invoice has already been received against this purchase order");
    const buf = Buffer.from(d.data.replace(/^data:.*?;base64,/, ""), "base64");
    if (!buf.length) throw new HttpError(400, "The file is empty");
    if (buf.length > 10 * 1024 * 1024) throw new HttpError(400, "The file can be up to 10 MB");
    const iso = new Date(new Date(d.invoiceDate).getTime() + 5.5 * 3600000).toISOString().slice(0, 10);
    const diff = Math.round((d.amount - p.total) * 100) / 100;
    const ctx = { org: p.organization, user: req.user };
    const { call } = require("../utils/import/commit");
    const bill = await call(require("./bills"), "POST", "/", ctx, {
      vendor: String(p.vendor),
      billNumber: d.invoiceNumber,
      date: iso,
      dueDate: iso,
      placeOfSupply: p.placeOfSupply || "",
      lineItems: p.lineItems.map((l) => ({ item: l.item ? String(l.item) : "", name: l.name, description: l.description || "", hsnSac: l.hsnSac || "", unit: l.unit || "", quantity: l.quantity, rate: l.rate, discount: l.discount || 0, taxRate: l.taxRate || 0, account: l.account || "" })),
      adjustment: p.adjustment || 0,
      ...(p.adjustmentAccount ? { adjustmentAccount: p.adjustmentAccount } : {}),
      customerNotes: [`Invoice uploaded by ${req.seller.name} (${req.user.name}) on the seller dashboard against PO ${p.number}.`, `Seller's invoice amount ₹${d.amount}${diff ? ` — differs from the PO total ₹${p.total} by ₹${diff}` : " (matches the PO)"}.`, d.note ? `Seller's note: ${d.note}` : ""].filter(Boolean).join("\n"),
      status: "draft",
      purchaseOrder: String(p._id),
    });
    await require("./attachments").store({ org: p.organization, user: req.user }, { docType: "bill", docId: bill._id, name: d.name, type: d.type, buf });
    res.status(201).send({ ok: true, differs: diff || 0, purchaseOrder: p.number });
  })
);

router.get(
  "/purchase-orders/:id",
  ah(async (req, res) => {
    const p = (await myPos(req.seller)).find((x) => String(x._id) === req.params.id);
    if (!p) throw new HttpError(404, "Purchase order not found");
    const Organization = require("../models/Organization");
    const org = await Organization.findById(p.organization, { name: 1, gstin: 1, address: 1, state: 1, email: 1, phone: 1, logo: 1 }).lean();
    res.send({ ...p, buyer: org });
  })
);

router.get(
  "/penalties",
  ah(async (req, res) => {
    res.send(await SellerPenalty.find({ seller: req.seller._id }, { date: 1, amount: 1, reason: 1, orderName: 1, purchaseOrderNumber: 1 }).sort({ date: -1 }).lean());
  })
);

module.exports = router;
