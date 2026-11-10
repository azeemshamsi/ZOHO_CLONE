/**
 * Flipkart (Seller API): the connection, order sync into Store → Orders, Pack / label / Ready to Dispatch for
 * Flipkart-logistics orders, self-ship courier codes, and the stock sync from Shopify. Mounted at /api/flipkart-orders.
 */
const router = require("express").Router();
const Joi = require("joi");
const { ah, validate, HttpError } = require("../utils/http");
const FlipkartAccount = require("../models/FlipkartAccount");
const ShopifyOrder = require("../models/ShopifyOrder");
const { tokenFor } = require("../utils/flipkart/client");
const FO = require("../utils/flipkart/orders");
const FI = require("../utils/flipkart/inventory");
const fail = (e) => (e instanceof HttpError ? e : new HttpError(400, e.message));

router.get(
  "/account",
  ah(async (req, res) => {
    const a = await FlipkartAccount.findOne({ organization: req.org });
    res.send(a ? a.toJSON() : null);
  })
);

router.put(
  "/account",
  ah(async (req, res) => {
    const d = validate(
      Joi.object({
        name: Joi.string().trim().max(80).allow(""),
        appId: Joi.string().trim().max(200).allow(""),
        appSecret: Joi.string().trim().max(300).allow(""), // blank = keep
        locationId: Joi.string().trim().max(80).allow(""),
        syncFrom: Joi.date().allow(null, ""),
        autoSync: Joi.boolean(),
        stockSync: Joi.boolean(),
        stockBuffer: Joi.number().integer().min(0).max(10000),
        reduceShopify: Joi.boolean(),
        selfShipPartners: Joi.object().pattern(Joi.string(), Joi.object({ name: Joi.string().allow(""), code: Joi.string().allow("") })),
      }),
      req.body
    );
    let a = await FlipkartAccount.findOne({ organization: req.org });
    if (!a) a = new FlipkartAccount({ organization: req.org });
    const credsChanged = (d.appId && d.appId !== a.appId) || !!d.appSecret;
    for (const k of ["name", "appId", "locationId", "autoSync", "stockSync", "stockBuffer", "reduceShopify", "selfShipPartners"]) if (d[k] !== undefined) a[k] = d[k];
    if (d.appSecret) a.appSecret = d.appSecret;
    if (d.syncFrom !== undefined) a.syncFrom = d.syncFrom || undefined;
    if (d.selfShipPartners) a.markModified("selfShipPartners");
    let firstConnect = false;
    if (a.appId && a.appSecret && (credsChanged || !a.connected)) {
      try {
        a.accessToken = "";
        await tokenFor(a, true);
        firstConnect = !a.connected;
        a.connected = true;
      } catch (e) {
        a.connected = false;
        await a.save();
        throw new HttpError(400, e.message);
      }
    }
    if (!a.syncFrom) a.syncFrom = new Date(Date.now() - 7 * 86400000);
    if (!a.reduceFrom) a.reduceFrom = new Date(); // orders placed before connecting are already in the Shopify stock
    await a.save();
    if (firstConnect) FO.syncAccount(a).catch((e) => console.error("Flipkart sync failed:", e.message));
    res.send(a.toJSON());
  })
);

router.delete(
  "/account",
  ah(async (req, res) => {
    await FlipkartAccount.deleteOne({ organization: req.org });
    res.send({ ok: true });
  })
);

router.post(
  "/sync",
  ah(async (req, res) => {
    const a = await FlipkartAccount.findOne({ organization: req.org });
    if (!a?.connected) throw new HttpError(400, "Connect Flipkart first (Store → Flipkart)");
    if (a.sync?.running && a.sync.startedAt > new Date(Date.now() - 30 * 60000)) return res.send({ running: true });
    FO.syncAccount(a, { full: !!req.body?.full }).catch((e) => console.error("Flipkart sync failed:", e.message));
    res.send({ running: true });
  })
);

router.post(
  "/stock-sync",
  ah(async (req, res) => {
    const a = await FlipkartAccount.findOne({ organization: req.org });
    if (!a?.connected) throw new HttpError(400, "Connect Flipkart first (Store → Flipkart)");
    if (a.stock?.running && a.stock.startedAt > new Date(Date.now() - 60 * 60000)) return res.send({ running: true });
    FI.syncStock(a, { relist: !!req.body?.relist }).catch((e) => console.error("Flipkart stock sync failed:", e.message));
    res.send({ running: true });
  })
);

router.get(
  "/self-ship-vendors",
  ah(async (req, res) => {
    const a = await FlipkartAccount.findOne({ organization: req.org });
    if (!a?.connected) throw new HttpError(400, "Connect Flipkart first");
    try {
      res.send(await FO.selfShipVendors(a));
    } catch (e) {
      throw fail(e);
    }
  })
);

/* ---------------- order actions ---------------- */
async function orderOf(req) {
  const o = await ShopifyOrder.findOne({ _id: req.params.id, organization: await FO.storeOrgFor(req.org), channel: "flipkart" });
  if (!o) throw new HttpError(404, "Flipkart order not found");
  return o;
}

router.post(
  "/orders/:id/pack",
  ah(async (req, res) => {
    const d = validate(Joi.object({ length: Joi.number().min(1).required(), breadth: Joi.number().min(1).required(), height: Joi.number().min(1).required(), weight: Joi.number().min(0.01).required() }), req.body);
    const o = await orderOf(req);
    try {
      res.send(await FO.pack(o, d));
    } catch (e) {
      throw fail(e);
    }
  })
);

router.post(
  "/orders/:id/rtd",
  ah(async (req, res) => {
    const o = await orderOf(req);
    try {
      res.send(await FO.readyToDispatch(o));
    } catch (e) {
      throw fail(e);
    }
  })
);

// Self-ship: report the booked courier + AWB to Flipkart again (e.g. after adding the courier code).
router.post(
  "/orders/:id/report-dispatch",
  ah(async (req, res) => {
    const o = await orderOf(req);
    if (!o.shipment?.awb) throw new HttpError(400, "Book a courier first");
    const w = await FO.afterSelfShipBooked(o);
    if (w) throw new HttpError(400, w.replace(/^Booked(, but)?\.? ?/, ""));
    res.send({ ok: true });
  })
);

// Mark how the order ships when Flipkart's data doesn't say (self-ship or Flipkart's courier).
router.put(
  "/orders/:id/self-ship",
  ah(async (req, res) => {
    const { selfShip } = validate(Joi.object({ selfShip: Joi.boolean().required() }), req.body);
    const o = await orderOf(req);
    o.flipkart = { ...o.flipkart, selfShip };
    o.markModified("flipkart");
    await o.save();
    require("../utils/shopify/orderIndex").forget(String(o.organization));
    res.send({ ok: true });
  })
);

router.moduleOf = function (req) {
  const p = req.path;
  if (p === "/account") return req.method === "GET" ? ["store_settings", "store_orders", "store_shipping"] : "store_settings";
  if (p === "/sync") return "store_orders";
  if (p === "/stock-sync" || p === "/self-ship-vendors") return "store_settings";
  return "store_shipping";
};
module.exports = router;
