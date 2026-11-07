/**
 * Amazon order processing (Selling Partner API): the connection, order sync into Store → Orders, confirming
 * self-ship tracking to Amazon, and Easy Ship pickups and labels. Mounted at /api/amazon-orders.
 * Orders themselves are listed, invoiced and booked through /api/shopify/orders like Shopify orders.
 */
const router = require("express").Router();
const Joi = require("joi");
const { ah, validate, HttpError } = require("../utils/http");
const AmazonAccount = require("../models/AmazonAccount");
const ShopifyOrder = require("../models/ShopifyOrder");
const Item = require("../models/Item");
const { tokenFor, call } = require("../utils/amazon/client");
const AO = require("../utils/amazon/orders");
const AS = require("../utils/amazon/ship");
const { resolvePackage } = require("../utils/shopify/package");

const audit = require("../utils/audit");
const fail = (e) => (e instanceof HttpError ? e : new HttpError(400, e.message));

router.get(
  "/account",
  ah(async (req, res) => {
    const a = await AmazonAccount.findOne({ organization: req.org });
    res.send(a ? a.toJSON() : null);
  })
);

router.put(
  "/account",
  ah(async (req, res) => {
    const d = validate(
      Joi.object({
        name: Joi.string().trim().max(80).allow(""),
        sellerId: Joi.string().trim().max(40).allow(""),
        clientId: Joi.string().trim().max(200).allow(""),
        clientSecret: Joi.string().trim().max(300).allow(""), // blank = keep
        refreshToken: Joi.string().trim().max(1000).allow(""), // blank = keep
        syncFrom: Joi.date().allow(null, ""),
        autoSync: Joi.boolean(),
        invoiceBy: Joi.string().valid("ordexago", "amazon"),
        invoiceStatus: Joi.string().valid("draft", "sent"),
        ledger: Joi.string().allow(""),
        shippingSac: Joi.string().trim().max(10).allow(""),
      }),
      req.body
    );
    let a = await AmazonAccount.findOne({ organization: req.org });
    if (!a) a = new AmazonAccount({ organization: req.org });
    const credsChanged = ["clientId", "clientSecret", "refreshToken"].some((k) => d[k] && d[k] !== a[k]);
    for (const k of ["name", "sellerId", "clientId", "autoSync", "invoiceBy", "invoiceStatus", "ledger", "shippingSac"]) if (d[k] !== undefined) a[k] = d[k];
    if (d.clientSecret) a.clientSecret = d.clientSecret;
    if (d.refreshToken) a.refreshToken = d.refreshToken;
    if (d.syncFrom !== undefined) a.syncFrom = d.syncFrom || undefined;
    if (credsChanged) {
      a.accessToken = "";
      a.tokenExpires = undefined;
    }
    // Check the keys: a token, then a one-order search.
    let firstConnect = false;
    if (a.clientId && a.clientSecret && a.refreshToken && (credsChanged || !a.connected)) {
      try {
        await tokenFor(a);
        await call(a, "GET", AO.SEARCH, { query: { marketplaceIds: a.marketplaceId, createdAfter: new Date(Date.now() - 86400000).toISOString(), maxResultsPerPage: 1 } });
        firstConnect = !a.connected;
        a.connected = true;
        a.sync = { ...(a.sync?.toObject ? a.sync.toObject() : a.sync), error: "" };
      } catch (e) {
        a.connected = false;
        await a.save();
        throw new HttpError(400, e.message);
      }
    }
    if (!a.syncFrom) a.syncFrom = new Date(Date.now() - 7 * 86400000);
    // Orders placed from today are invoiced by OrdexaGo; earlier ones come in through the monthly MTR import.
    if (!a.invoiceFrom) a.invoiceFrom = new Date();
    await a.save();
    if (firstConnect) AO.syncAccount(a).catch((e) => console.error("Amazon sync failed:", e.message));
    res.send(a.toJSON());
  })
);

router.delete(
  "/account",
  ah(async (req, res) => {
    await AmazonAccount.deleteOne({ organization: req.org });
    res.send({ ok: true });
  })
);

router.post(
  "/sync",
  ah(async (req, res) => {
    const a = await AmazonAccount.findOne({ organization: req.org });
    if (!a?.connected) throw new HttpError(400, "Connect Amazon first (Store → Amazon)");
    if (a.sync?.running && a.sync.startedAt > new Date(Date.now() - 30 * 60000)) return res.send({ running: true });
    AO.syncAccount(a, { full: !!req.body?.full }).catch((e) => console.error("Amazon sync failed:", e.message));
    res.send({ running: true });
  })
);

/* ---------------- order actions ---------------- */
async function orderOf(req) {
  const o = await ShopifyOrder.findOne({ _id: req.params.id, organization: await AO.storeOrgFor(req.org), channel: "amazon" });
  if (!o) throw new HttpError(404, "Amazon order not found");
  await audit.amazonAccess(req, "amazon_order_action", o.name, { action: req.path.split("/").slice(3).join("/"), orderId: String(o._id) });
  return o;
}
const pkgJoi = Joi.object({ packageType: Joi.string().allow("", null), weight: Joi.number().min(0).allow(null, ""), length: Joi.number().min(0).allow(null, ""), breadth: Joi.number().min(0).allow(null, ""), height: Joi.number().min(0).allow(null, "") }).default({});

async function pkgOf(o, input) {
  const items = new Map((await Item.find({ _id: { $in: o.lines.map((l) => l.item).filter(Boolean) } }).lean()).map((i) => [String(i._id), i]));
  const p = await resolvePackage(o, input, o.organization, items);
  if (!p) throw new HttpError(400, "Its products have no package type — choose a package or enter the weight and size");
  return p;
}

// Tell Amazon the courier and AWB again (when it failed at booking).
router.post(
  "/orders/:id/confirm",
  ah(async (req, res) => {
    const o = await orderOf(req);
    try {
      await AS.confirmShipment(o);
    } catch (e) {
      o.amazon = { ...o.amazon, confirmError: e.message };
      o.markModified("amazon");
      await o.save();
      throw fail(e);
    }
    res.send({ ok: true, confirmedAt: o.amazon.confirmedAt });
  })
);

router.post(
  "/orders/:id/easyship/slots",
  ah(async (req, res) => {
    const d = validate(Joi.object({ pkg: pkgJoi }), req.body);
    const o = await orderOf(req);
    try {
      const pkg = await pkgOf(o, d.pkg);
      res.send({ pkg, slots: await AS.handoverSlots(o, pkg) });
    } catch (e) {
      throw fail(e);
    }
  })
);

router.post(
  "/orders/:id/easyship/schedule",
  ah(async (req, res) => {
    const d = validate(Joi.object({ slotId: Joi.string().required(), pkg: pkgJoi }), req.body);
    const o = await orderOf(req);
    try {
      const pkg = await pkgOf(o, d.pkg);
      res.send(await AS.schedule(o, { slotId: d.slotId, pkg }));
    } catch (e) {
      throw fail(e);
    }
  })
);

// Fetch Amazon's label (once it's ready the order's label link serves the PDF).
router.post(
  "/orders/:id/easyship/label",
  ah(async (req, res) => {
    const o = await orderOf(req);
    try {
      res.send(await AS.fetchLabel(o));
    } catch (e) {
      throw fail(e);
    }
  })
);

router.moduleOf = function (req) {
  const p = req.path;
  if (p === "/account") return req.method === "GET" ? ["store_settings", "store_orders", "store_shipping"] : "store_settings";
  if (p === "/sync") return "store_orders";
  return "store_shipping";
};
module.exports = router;
