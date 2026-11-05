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
function view(o, s) {
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
    lines: lines.map((l) => ({ title: l.title, variantTitle: l.variantTitle, sku: l.sku, quantity: l.quantity, unitPrice: l.unitPrice, image: l.image, payout: S.linePurchase(s, l) })),
    otherItems: (o.lines || []).filter((l) => l.quantity > 0).length - lines.filter((l) => l.quantity > 0).length,
    value: Math.round(value * 100) / 100,
    payout: Math.round(lines.reduce((t, l) => t + S.linePurchase(s, l), 0) * 100) / 100,
    shipment: sh.awb ? { courierName: sh.courierName, awb: sh.awb, trackStatus: sh.trackStatus, trackingUrl: sh.trackingUrl, bookedAt: sh.bookedAt, fromYou: !!mine, events: (sh.events || []).slice(0, 10) } : null,
    deliveredAt: o.deliveredAt || null,
    settled: settled ? { number: settled.number, amount: settled.amount, at: settled.at } : null,
  };
}

router.get(
  "/me",
  ah(async (req, res) => {
    const s = req.seller;
    const orders = await ShopifyOrder.find({ organization: s.organization, sellers: s._id }, { status: 1, orderDate: 1, deliveredAt: 1, statusChangedAt: 1, sellerSettled: 1, lines: 1 }).lean();
    const counts = Object.fromEntries(STATUSES.map((k) => [k, 0]));
    for (const o of orders) counts[o.status] = (counts[o.status] || 0) + 1;
    const toSettle = orders.filter((o) => o.status === "delivered" && !(o.sellerSettled || []).some((x) => String(x.seller) === String(s._id)));
    const brands = new Set(s.brands.map(S.norm));
    const due = toSettle.reduce((t, o) => t + o.lines.filter((l) => brands.has(S.norm(l.vendor))).reduce((u, l) => u + S.linePurchase(s, l), 0), 0);
    const penalties = await SellerPenalty.find({ seller: s._id, purchaseOrder: { $exists: false } }, { amount: 1 }).lean();
    res.send({
      seller: { _id: s._id, name: s.name, brands: s.brands, rate: s.rate, contactName: s.contactName, email: s.email, phone: s.phone, gstin: s.gstin, pickup: s.pickup },
      counts: { ...counts, open: OPEN.reduce((t, k) => t + counts[k], 0), all: orders.length },
      deliveredNotOnPo: { orders: toSettle.length, amount: Math.round(due * 100) / 100 },
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
    let rows = list.map((o) => view(o, s));
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

router.get(
  "/purchase-orders",
  ah(async (req, res) => {
    res.send((await myPos(req.seller)).map((p) => ({ _id: p._id, number: p.number, date: p.date, reference: p.reference, status: p.status, total: p.total, billNumber: p.billNumber, lines: p.lineItems.length })));
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
