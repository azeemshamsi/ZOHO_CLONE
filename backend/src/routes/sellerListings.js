/**
 * Store → Sellers → Listings: products sellers uploaded from their dashboard (draft on Shopify). The team checks
 * each one, sets the selling price and approves it (active on the website) or rejects it. Mounted at
 * /api/seller-listings with the store_sellers permission.
 */
const router = require("express").Router();
const Joi = require("joi");
const SellerListing = require("../models/SellerListing");
const ShopifyStore = require("../models/ShopifyStore");
const { ah, validate, HttpError } = require("../utils/http");
const L = require("../utils/sellerListings");

router.use(
  ah(async (req, res, next) => {
    if (
      await ShopifyStore.exists({
        organization: req.org,
        shop: { $nin: ["", null] },
      })
    )
      req.storeOrg = req.org;
    else {
      const shared = await ShopifyStore.findOne(
        { sharedWith: req.org, connected: true },
        { organization: 1 },
      ).lean();
      req.storeOrg = shared ? shared.organization : req.org;
    }
    next();
  }),
);

// ?status=review (default: waiting for us) | draft | failed | approved | rejected | all & seller & q
router.get(
  "/",
  ah(async (req, res) => {
    const all = await SellerListing.find({ organization: req.storeOrg })
      .sort({ createdAt: -1 })
      .limit(5000)
      .lean();
    if (all.some((l) => l.status === "queued"))
      L.processQueue(req.storeOrg).catch(() => {});
    const counts = { all: all.length, review: 0 };
    for (const l of all) {
      counts[l.status] = (counts[l.status] || 0) + 1;
      if (["queued", "creating", "draft"].includes(l.status)) counts.review++;
    }
    const st = req.query.status || "review";
    const q = String(req.query.q || "")
      .trim()
      .toLowerCase();
    const rows = all.filter(
      (l) =>
        (st === "all" ||
          (st === "review"
            ? ["queued", "creating", "draft"].includes(l.status)
            : l.status === st)) &&
        (!req.query.seller || String(l.seller) === req.query.seller) &&
        (!q ||
          [
            l.title,
            l.brand,
            l.sellerName,
            l.handle,
            ...(l.variants || []).map((v) => v.sku),
          ].some((x) =>
            String(x || "")
              .toLowerCase()
              .includes(q),
          )),
    );
    const store = await ShopifyStore.findOne(
      { organization: req.storeOrg },
      { shop: 1 },
    ).lean();
    res.send({
      rows: rows.slice(0, 500),
      total: rows.length,
      counts,
      adminBase: store?.shop
        ? `https://admin.shopify.com/store/${store.shop.replace(/\.myshopify\.com$/, "")}/products/`
        : "",
    });
  }),
);

const load = async (req) => {
  const l = await SellerListing.findOne({
    _id: req.params.id,
    organization: req.storeOrg,
  });
  if (!l) throw new HttpError(404, "Listing not found");
  return l;
};

router.post(
  "/:id/approve",
  ah(async (req, res) => {
    const d = validate(
      Joi.object({
        prices: Joi.array()
          .items(
            Joi.object({
              sku: Joi.string().required(),
              price: Joi.number().min(0).allow(null),
              compareAtPrice: Joi.number().min(0).allow(null),
            }),
          )
          .default([]),
      }),
      req.body,
    );
    const l = await load(req);
    if (l.status !== "draft")
      throw new HttpError(
        400,
        l.status === "approved"
          ? "Already approved"
          : "Only a draft on Shopify can be approved",
      );
    try {
      const r = await L.approve(l, d.prices, req.user);
      res.send({ listing: l, ...r });
    } catch (e) {
      throw new HttpError(400, e.message);
    }
  }),
);

router.post(
  "/:id/reject",
  ah(async (req, res) => {
    const d = validate(
      Joi.object({
        reason: Joi.string().trim().min(3).max(500).required().label("Reason"),
        deleteDraft: Joi.boolean().default(true),
      }),
      req.body,
    );
    const l = await load(req);
    if (["approved", "rejected"].includes(l.status))
      throw new HttpError(400, `Already ${l.status}`);
    await L.reject(l, d.reason, req.user, { deleteDraft: d.deleteDraft });
    res.send({ listing: l });
  }),
);

// Try a failed one again (e.g. after the Shopify scope was added or the image link fixed in Shopify).
router.post(
  "/:id/retry",
  ah(async (req, res) => {
    const l = await load(req);
    if (l.status !== "failed")
      throw new HttpError(400, "Only a failed listing can be retried");
    l.status = "queued";
    l.error = "";
    await l.save();
    L.processQueue(req.storeOrg).catch(() => {});
    res.send({ listing: l });
  }),
);

router.post(
  "/retry-failed",
  ah(async (req, res) => {
    const r = await SellerListing.updateMany(
      { organization: req.storeOrg, status: "failed" },
      { $set: { status: "queued", error: "" } },
    );
    L.processQueue(req.storeOrg).catch(() => {});
    res.send({ queued: r.modifiedCount ?? r.nModified ?? 0 });
  }),
);

module.exports = router;
