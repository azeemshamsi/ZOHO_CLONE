// Shopify webhooks (orders/create, orders/updated). No login: verified with the app's client secret.
const crypto = require("crypto");
const router = require("express").Router();
const ShopifyStore = require("../models/ShopifyStore");
const { syncSoon } = require("../utils/shopify/sync");

router.post("/:storeId", async (req, res) => {
  try {
    const store = await ShopifyStore.findById(req.params.storeId).catch(() => null);
    const hmac = req.get("X-Shopify-Hmac-Sha256") || "";
    if (!store?.clientSecret || !Buffer.isBuffer(req.body)) return res.status(401).end();
    const digest = crypto.createHmac("sha256", store.clientSecret).update(req.body).digest("base64");
    const a = Buffer.from(digest);
    const b = Buffer.from(hmac);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).end();
    syncSoon(store);
    res.status(200).send("ok");
  } catch {
    res.status(200).send("ok");
  }
});

module.exports = router;
