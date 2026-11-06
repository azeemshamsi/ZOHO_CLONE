/**
 * Marketplace sellers (Store → Sellers): sellers and their brands, purchase rate, pickup address, courier pickups,
 * logins, penalties and the monthly purchase orders. Mounted at /api/sellers. Everything lives with the Shopify
 * store's company (a company that shares another company's store sees that store's sellers).
 */
const router = require("express").Router();
const crypto = require("crypto");
const Joi = require("joi");
const env = require("../config/env");
const Seller = require("../models/Seller");
const SellerPenalty = require("../models/SellerPenalty");
const ShopifyOrder = require("../models/ShopifyOrder");
const ShopifyStore = require("../models/ShopifyStore");
const CourierAccount = require("../models/CourierAccount");
const User = require("../models/User");
const Membership = require("../models/Membership");
const { ah, validate, HttpError } = require("../utils/http");
const S = require("../utils/sellers");

router.use(
  ah(async (req, res, next) => {
    if (await ShopifyStore.exists({ organization: req.org, shop: { $nin: ["", null] } })) req.storeOrg = req.org;
    else {
      const shared = await ShopifyStore.findOne({ sharedWith: req.org, connected: true }, { organization: 1 }).lean();
      req.storeOrg = shared ? shared.organization : req.org;
    }
    next();
  })
);

const sellerJoi = Joi.object({
  name: Joi.string().trim().min(2).max(150).required().label("Seller name"),
  brands: Joi.array().items(Joi.string().trim().min(1).max(150)).min(1).required().label("Brands (Shopify vendor)"),
  rate: Joi.number().min(0).max(100).required().label("Purchase rate %"),
  poFrom: Joi.date().allow(null, "").label("Purchase orders from"),
  contactName: Joi.string().allow("").max(100),
  email: Joi.string().email().allow("").label("Email"),
  phone: Joi.string().allow("").max(20),
  gstin: Joi.string().allow("").uppercase().pattern(/^$|^\d{2}[A-Z0-9]{13}$/).message("GSTIN must be 15 characters"),
  pan: Joi.string().allow("").uppercase().pattern(/^$|^[A-Z]{5}[0-9]{4}[A-Z]$/).message("PAN must look like ABCDE1234F"),
  pickup: Joi.object({ name: Joi.string().allow(""), phone: Joi.string().allow(""), address: Joi.string().allow(""), city: Joi.string().allow(""), state: Joi.string().allow(""), pincode: Joi.string().allow("").pattern(/^$|^\d{6}$/).message("Pincode must be 6 digits") }).default({}),
  active: Joi.boolean(),
  notes: Joi.string().allow("").max(2000),
});

// No other seller may already claim one of these brands.
async function checkBrands(org, brands, id) {
  const taken = new Map();
  for (const s of await Seller.find({ organization: org, ...(id ? { _id: { $ne: id } } : {}) }).lean()) for (const b of s.brands || []) taken.set(S.norm(b), s.name);
  for (const b of brands) if (taken.has(S.norm(b))) throw new HttpError(409, `"${b}" is already ${taken.get(S.norm(b))}'s brand`);
}

const cleanBrands = (list) => [...new Map(list.map((b) => [S.norm(b), b.trim()])).values()];

router.get(
  "/",
  ah(async (req, res) => {
    const sellers = await Seller.find({ organization: req.storeOrg }).sort({ active: -1, name: 1 }).lean();
    const ids = sellers.map((s) => s._id);
    const [orders, penalties, logins] = await Promise.all([
      ids.length ? ShopifyOrder.find({ organization: req.storeOrg, sellers: { $in: ids } }, { sellers: 1, status: 1, sellerSettled: 1, deliveredAt: 1, statusChangedAt: 1 }).lean() : [],
      ids.length ? SellerPenalty.find({ organization: req.storeOrg, seller: { $in: ids } }, { seller: 1, amount: 1, purchaseOrder: 1 }).lean() : [],
      ids.length ? Membership.find({ organization: req.storeOrg, seller: { $in: ids } }, { seller: 1 }).lean() : [],
    ]);
    res.send(
      sellers.map((s) => {
        const id = String(s._id);
        const mine = orders.filter((o) => o.sellers.map(String).includes(id));
        return {
          ...s,
          stats: {
            orders: mine.length,
            open: mine.filter((o) => ["new", "packed", "ready_to_ship", "shipped"].includes(o.status)).length,
            deliveredUnsettled: mine.filter((o) => o.status === "delivered" && (!s.poFrom || S.deliveredOn(o) >= s.poFrom) && !(o.sellerSettled || []).some((x) => String(x.seller) === id)).length,
            penaltiesPending: penalties.filter((p) => String(p.seller) === id && !p.purchaseOrder).reduce((t, p) => t + p.amount, 0),
            logins: logins.filter((m) => String(m.seller) === id).length,
          },
        };
      })
    );
  })
);

// Shopify vendors seen on orders, with the seller each belongs to (for picking brands).
router.get(
  "/brands",
  ah(async (req, res) => {
    const map = await S.brandMap(req.storeOrg);
    const count = new Map();
    for (const o of await ShopifyOrder.find({ organization: req.storeOrg }, { "lines.vendor": 1 }).lean())
      for (const l of o.lines || []) {
        if (!l.vendor) continue;
        const k = S.norm(l.vendor);
        const c = count.get(k) || { brand: l.vendor.trim(), orders: 0 };
        c.orders++;
        count.set(k, c);
      }
    const all = await Seller.find({ organization: req.storeOrg }, { name: 1, brands: 1 }).lean();
    const owner = new Map(all.flatMap((s) => s.brands.map((b) => [S.norm(b), s.name])));
    for (const s of all) for (const b of s.brands) if (!count.has(S.norm(b))) count.set(S.norm(b), { brand: b, orders: 0 });
    void map;
    res.send([...count.entries()].map(([k, c]) => ({ ...c, seller: owner.get(k) || "" })).sort((a, b) => b.orders - a.orders || a.brand.localeCompare(b.brand)));
  })
);

router.post(
  "/",
  ah(async (req, res) => {
    const d = validate(sellerJoi, req.body);
    d.brands = cleanBrands(d.brands);
    await checkBrands(req.storeOrg, d.brands);
    // Purchase orders start from the 1st of last month unless set (older deliveries were settled outside OrdexaGo).
    if (!d.poFrom) {
      const t = new Date(Date.now() + 5.5 * 3600000);
      d.poFrom = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() - 1, 1) - 5.5 * 3600000);
    }
    const s = await Seller.create({ ...d, organization: req.storeOrg });
    const tagged = await S.assignAll(req.storeOrg);
    res.status(201).send({ seller: s, ordersTagged: tagged });
  })
);

router.get(
  "/:id",
  ah(async (req, res) => {
    const s = await Seller.findOne({ _id: req.params.id, organization: req.storeOrg }).lean();
    if (!s) throw new HttpError(404, "Seller not found");
    const [ms, penalties, accounts] = await Promise.all([
      Membership.find({ organization: req.storeOrg, seller: s._id }).populate("user", "name email status lastLogin").lean(),
      SellerPenalty.find({ organization: req.storeOrg, seller: s._id }).sort({ date: -1 }).lean(),
      CourierAccount.find({ organization: req.storeOrg, active: true }).sort({ isDefault: -1, name: 1 }),
    ]);
    const PurchaseOrder = require("../models/PurchaseOrder");
    const vendorIds = Object.values(s.vendors || {});
    const pos = vendorIds.length ? await PurchaseOrder.find({ vendor: { $in: vendorIds } }, { number: 1, date: 1, total: 1, status: 1, billNumber: 1, reference: 1, organization: 1 }).sort({ date: -1 }).lean() : [];
    res.send({
      ...s,
      users: ms.filter((m) => m.user).map((m) => ({ _id: m.user._id, name: m.user.name, email: m.user.email, status: m.user.status === "invited" ? "invited" : m.status, lastLogin: m.user.lastLogin })),
      penalties,
      purchaseOrders: pos,
      couriers: accounts.map((a) => ({ account: String(a._id), name: a.name, carrier: a.carrier, ...((s.couriers || {})[String(a._id)] || {}), needsRegister: ["shiprocket", "delhivery"].includes(a.carrier) })),
      pickupMissing: S.pickupProblems(s),
    });
  })
);

router.put(
  "/:id",
  ah(async (req, res) => {
    const d = validate(sellerJoi, req.body);
    d.brands = cleanBrands(d.brands);
    const s = await Seller.findOne({ _id: req.params.id, organization: req.storeOrg });
    if (!s) throw new HttpError(404, "Seller not found");
    await checkBrands(req.storeOrg, d.brands, s._id);
    if (d.poFrom === "") d.poFrom = null;
    const addrChanged = ["address", "city", "state", "pincode", "phone"].some((k) => (d.pickup?.[k] || "") !== (s.pickup?.[k] || ""));
    s.set(d);
    // A new pickup address must be registered with the couriers again.
    if (addrChanged) s.couriers = Object.fromEntries(Object.entries(s.couriers || {}).map(([k, v]) => [k, { ...v, status: v.pickupLocation ? "address_changed" : v.status }]));
    s.markModified("couriers");
    await s.save();
    const tagged = await S.assignAll(req.storeOrg);
    res.send({ seller: s, ordersTagged: tagged, addressChanged: addrChanged });
  })
);

router.delete(
  "/:id",
  ah(async (req, res) => {
    const s = await Seller.findOne({ _id: req.params.id, organization: req.storeOrg });
    if (!s) throw new HttpError(404, "Seller not found");
    if (await ShopifyOrder.exists({ organization: req.storeOrg, "sellerSettled.seller": s._id })) throw new HttpError(400, "This seller has purchase orders. Mark them inactive instead.");
    await Membership.deleteMany({ organization: req.storeOrg, seller: s._id, role: "seller" });
    await SellerPenalty.deleteMany({ seller: s._id, purchaseOrder: { $exists: false } });
    await s.deleteOne();
    await S.assignAll(req.storeOrg);
    res.send({ ok: true });
  })
);

/* ---------- logins ---------- */
router.post(
  "/:id/users",
  ah(async (req, res) => {
    const d = validate(Joi.object({ name: Joi.string().trim().min(2).max(100).required().label("Name"), email: Joi.string().email().required().label("Email") }), req.body);
    const s = await Seller.findOne({ _id: req.params.id, organization: req.storeOrg });
    if (!s) throw new HttpError(404, "Seller not found");
    const email = d.email.toLowerCase();
    let user = await User.findOne({ email });
    if (user && (await Membership.exists({ user: user._id, organization: req.storeOrg }))) throw new HttpError(409, "This email already has a login in this company. Use a different email for the seller.");
    await require("../utils/subscription").checkLimit(req.storeOrg, "users", { userId: user?._id });
    if (!user) user = new User({ name: d.name, email, role: "seller", organization: req.storeOrg, status: "invited", invitedBy: req.user._id, verified: true });
    let link = "";
    let emailed = false;
    if (user.status === "invited" || user.isNew) {
      user.inviteToken = crypto.randomBytes(24).toString("hex");
      user.inviteExpires = new Date(Date.now() + 14 * 86400000);
      await user.save();
      const base = req.get("origin") || env.APP_URL;
      link = `${base.replace(/\/+$/, "")}/invite/${user._id}/${user.inviteToken}`;
      try {
        await require("../utils/sendEmail")(email, `Your ${s.name} seller login on OrdexaGo`, `Hi ${d.name},\n\nYou can now see your orders, download shipping labels, update your stock and see your purchase orders on OrdexaGo.\n\nSet your password: ${link}\n\nThe link works for 14 days. After that, log in at ${base}/login.`);
        emailed = true;
      } catch (e) {
        console.error(`[seller invite] ${e.message}`);
      }
    }
    await Membership.create({ user: user._id, organization: req.storeOrg, role: "seller", seller: s._id, status: user.status === "invited" ? "invited" : "active", invitedBy: req.user._id });
    res.status(201).send({ link, emailed, existing: !link });
  })
);

router.delete(
  "/:id/users/:userId",
  ah(async (req, res) => {
    const m = await Membership.findOne({ organization: req.storeOrg, seller: req.params.id, user: req.params.userId, role: "seller" });
    if (!m) throw new HttpError(404, "Login not found");
    await m.deleteOne();
    // A login made only for this seller goes too.
    if (!(await Membership.exists({ user: req.params.userId }))) await User.deleteOne({ _id: req.params.userId });
    res.send({ ok: true });
  })
);

/* ---------- courier pickup locations ---------- */
router.post(
  "/:id/couriers/:account/register",
  ah(async (req, res) => {
    const s = await Seller.findOne({ _id: req.params.id, organization: req.storeOrg });
    const acc = s && (await CourierAccount.findOne({ _id: req.params.account, organization: req.storeOrg }));
    if (!acc) throw new HttpError(404, "Seller or courier not found");
    try {
      res.send(await S.registerPickup(s, acc));
    } catch (e) {
      const couriers = { ...(s.couriers || {}), [String(acc._id)]: { ...((s.couriers || {})[String(acc._id)] || {}), error: e.message, at: new Date() } };
      await Seller.updateOne({ _id: s._id }, { $set: { couriers } });
      throw new HttpError(400, e.message);
    }
  })
);

router.put(
  "/:id/couriers/:account",
  ah(async (req, res) => {
    const d = validate(Joi.object({ pickupLocation: Joi.string().allow("").max(100), originArea: Joi.string().allow("").max(10), customerCode: Joi.string().allow("").max(20), vendorCode: Joi.string().allow("").max(20) }), req.body);
    const s = await Seller.findOne({ _id: req.params.id, organization: req.storeOrg });
    if (!s) throw new HttpError(404, "Seller not found");
    const k = req.params.account;
    const couriers = { ...(s.couriers || {}), [k]: { ...((s.couriers || {})[k] || {}), ...d, status: d.pickupLocation ? "entered" : (s.couriers || {})[k]?.status || "", error: "", at: new Date() } };
    await Seller.updateOne({ _id: s._id }, { $set: { couriers } });
    res.send(couriers[k]);
  })
);

/* ---------- penalties ---------- */
router.get(
  "/penalties/list",
  ah(async (req, res) => {
    const f = { organization: req.storeOrg };
    if (req.query.seller) f.seller = req.query.seller;
    const list = await SellerPenalty.find(f).populate("seller", "name").sort({ date: -1 }).limit(1000).lean();
    res.send(list.filter((p) => !req.query.state || (req.query.state === "pending" ? !p.purchaseOrder : !!p.purchaseOrder)));
  })
);

router.post(
  "/penalties",
  ah(async (req, res) => {
    const d = validate(Joi.object({ seller: Joi.string().required().label("Seller"), date: Joi.date().required().label("Date"), amount: Joi.number().greater(0).required().label("Amount"), reason: Joi.string().trim().min(2).max(300).required().label("Reason"), orderName: Joi.string().allow("").max(30) }), req.body);
    const s = await Seller.findOne({ _id: d.seller, organization: req.storeOrg });
    if (!s) throw new HttpError(400, "Choose a seller");
    let order = null;
    if (d.orderName) {
      const n = d.orderName.trim().startsWith("#") ? d.orderName.trim() : `#${d.orderName.trim()}`;
      order = await ShopifyOrder.findOne({ organization: req.storeOrg, name: n }, { name: 1, sellers: 1 });
      if (!order) throw new HttpError(400, `Order ${n} not found`);
      if (!order.sellers.map(String).includes(String(s._id))) throw new HttpError(400, `${n} has no ${s.name} products`);
    }
    const p = await SellerPenalty.create({ organization: req.storeOrg, seller: s._id, date: d.date, amount: d.amount, reason: d.reason, order: order?._id, orderName: order?.name || "", createdBy: req.user._id });
    res.status(201).send(p);
  })
);

router.delete(
  "/penalties/:pid",
  ah(async (req, res) => {
    const p = await SellerPenalty.findOne({ _id: req.params.pid, organization: req.storeOrg });
    if (!p) throw new HttpError(404, "Deduction not found");
    if (p.purchaseOrder) throw new HttpError(400, `Already deducted on purchase order ${p.purchaseOrderNumber}`);
    await p.deleteOne();
    res.send({ ok: true });
  })
);

/* ---------- monthly purchase orders ---------- */
const monthJoi = Joi.string().pattern(/^\d{4}-\d{2}$/).required().label("Month");

router.get(
  "/purchase-orders/preview",
  ah(async (req, res) => {
    const { month } = validate(Joi.object({ month: monthJoi }), req.query);
    res.send({ month, label: S.monthRange(month).label, results: await S.runMonthly(req.storeOrg, month, req.user, { dryRun: true }) });
  })
);

router.post(
  "/purchase-orders/run",
  ah(async (req, res) => {
    const d = validate(Joi.object({ month: monthJoi, seller: Joi.string().allow("") }), req.body);
    const results = await S.runMonthly(req.storeOrg, d.month, req.user, { sellerId: d.seller || undefined });
    const mongoose = require("mongoose");
    await mongoose.connection.db.collection("seller_po_runs").updateOne({ _id: `${req.storeOrg}:${d.month}` }, { $set: { at: new Date(), manual: true }, $push: { history: { at: new Date(), by: String(req.user._id), results } } }, { upsert: true });
    res.send({ month: d.month, results });
  })
);

module.exports = router;
