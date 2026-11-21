/**
 * Seller registration from the store's website (woodentwist.com/pages/sell-online): a public form posts here and the
 * seller is created in OrdexaGo as "pending", waiting for the team's approval (Store → Sellers → Registrations).
 * Mounted at /api/public/seller-register before the app's CORS rule, because the website is another origin.
 *
 * Abuse guards: a hidden honeypot field, a per-IP limit, one open registration per email / phone / GSTIN,
 * and the form must name a connected store (its myshopify domain).
 */
const router = require("express").Router();
const Joi = require("joi");
const Seller = require("../models/Seller");
const ShopifyStore = require("../models/ShopifyStore");
const Organization = require("../models/Organization");
const { STATES } = require("../utils/states");

// Any website may post the form (it's public); nothing is read back but a short message.
router.use((req, res, next) => {
  res.set({
    "Access-Control-Allow-Origin": req.get("origin") || "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
    "Cross-Origin-Resource-Policy": "cross-origin",
  });
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const hits = new Map(); // ip → [times]
function limited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < 3600000);
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 5000)
    for (const [k, v] of hits)
      if (!v.some((t) => now - t < 3600000)) hits.delete(k);
  return list.length > 5;
}

const stateCodeOf = (v) => {
  const s = String(v || "").trim();
  if (!s) return "";
  if (STATES.some(([c]) => c === s)) return s;
  const hit = STATES.find(([, n]) => n.toLowerCase() === s.toLowerCase());
  return hit ? hit[0] : "";
};

const schema = Joi.object({
  shop: Joi.string().trim().max(200).required(),
  brand: Joi.string().trim().min(2).max(100).required().label("Brand name"),
  businessName: Joi.string()
    .trim()
    .min(2)
    .max(150)
    .required()
    .label("Business name"),
  contactName: Joi.string()
    .trim()
    .min(2)
    .max(100)
    .required()
    .label("Your name"),
  email: Joi.string().trim().email().max(150).required().label("Email"),
  phone: Joi.string()
    .trim()
    .max(20)
    .required()
    .label("Mobile number")
    .custom((v, h) =>
      /^(91)?[6-9]\d{9}$/.test(v.replace(/\D/g, "").replace(/^0+/, ""))
        ? v
        : h.error("any.invalid"),
    )
    .messages({ "any.invalid": "Enter a 10-digit Indian mobile number" }),
  gstin: Joi.string()
    .trim()
    .uppercase()
    .allow("")
    .pattern(/^$|^\d{2}[A-Z0-9]{13}$/)
    .label("GSTIN")
    .messages({ "string.pattern.base": "GSTIN must be 15 characters" }),
  pan: Joi.string()
    .trim()
    .uppercase()
    .allow("")
    .pattern(/^$|^[A-Z]{5}[0-9]{4}[A-Z]$/)
    .label("PAN")
    .messages({ "string.pattern.base": "PAN must look like ABCDE1234F" }),
  address: Joi.string()
    .trim()
    .min(5)
    .max(300)
    .required()
    .label("Pickup address"),
  city: Joi.string().trim().min(2).max(80).required().label("City"),
  state: Joi.string().trim().min(2).max(60).required().label("State"),
  pincode: Joi.string()
    .trim()
    .pattern(/^\d{6}$/)
    .required()
    .label("Pincode")
    .messages({ "string.pattern.base": "Pincode must be 6 digits" }),
  categories: Joi.string().trim().allow("").max(300).label("Categories"),
  productCount: Joi.string().trim().allow("").max(30),
  website: Joi.string().trim().allow("").max(300),
  message: Joi.string().trim().allow("").max(2000),
  agree: Joi.alternatives(Joi.boolean(), Joi.string()).required(),
  company_url: Joi.string().allow(""), // honeypot: people never see it, bots fill it
}).unknown(false);

router.post("/", async (req, res) => {
  try {
    let body = req.body;
    if (typeof body === "string") body = JSON.parse(body || "{}");
    if (body?.company_url)
      return res.send({
        ok: true,
        message:
          "Thank you! We'll review your registration and get back to you.",
      }); // bot
    if (limited(req.ip))
      return res
        .status(429)
        .send({
          error:
            "Too many registrations from here. Please try again in an hour.",
        });
    const { error, value: d } = schema.validate(body || {}, {
      abortEarly: true,
      stripUnknown: false,
    });
    if (error)
      return res
        .status(400)
        .send({ error: error.details[0].message.replace(/"/g, "") });
    if (!(d.agree === true || d.agree === "true" || d.agree === "on"))
      return res.status(400).send({ error: "Please accept the seller terms" });
    const shop = d.shop
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/\/.*$/, "");
    const store = await ShopifyStore.findOne({ shop, connected: true });
    if (!store)
      return res
        .status(400)
        .send({
          error: "Registration isn't open right now. Please email us instead.",
        });
    const org = store.organization;
    const state = stateCodeOf(d.state);
    if (!state) return res.status(400).send({ error: "Choose your state" });
    const phone = d.phone.replace(/\D/g, "").slice(-10);
    const email = d.email.toLowerCase();
    // One registration per seller: an approved seller or an open registration with this email / phone / GSTIN.
    const clash = (
      await Seller.find(
        { organization: org, status: { $ne: "rejected" } },
        { email: 1, phone: 1, gstin: 1, status: 1, brands: 1, application: 1 },
      ).lean()
    ).find(
      (s) =>
        (s.email && s.email === email) ||
        (s.phone && s.phone.replace(/\D/g, "").slice(-10) === phone) ||
        (d.gstin && s.gstin === d.gstin),
    );
    if (clash)
      return res
        .status(409)
        .send({
          error:
            clash.status === "pending"
              ? "You've already registered — we're reviewing it and will contact you soon."
              : "You're already a seller with us. Log in to your seller dashboard, or contact us.",
        });
    const brandTaken = (
      await Seller.find(
        { organization: org, status: "approved" },
        { brands: 1 },
      ).lean()
    ).some((s) =>
      (s.brands || []).some(
        (b) => b.trim().toLowerCase() === d.brand.toLowerCase(),
      ),
    );
    if (brandTaken)
      return res
        .status(409)
        .send({
          error: `The brand "${d.brand}" is already on our store. If it's yours, please contact us.`,
        });
    const s = await Seller.create({
      organization: org,
      name: d.businessName,
      brands: [],
      rate: 0,
      contactName: d.contactName,
      email,
      phone,
      gstin: d.gstin || "",
      pan: d.pan || "",
      pickup: {
        name: d.businessName,
        phone,
        address: d.address,
        city: d.city,
        state,
        pincode: d.pincode,
      },
      active: false,
      status: "pending",
      application: {
        source: "website",
        brand: d.brand,
        categories: d.categories,
        productCount: d.productCount,
        website: d.website,
        message: d.message,
        appliedAt: new Date(),
        ip: req.ip,
        origin: req.get("origin") || "",
      },
    });
    // Tell the team and the seller.
    const sendEmail = require("../utils/sendEmail");
    const o = await Organization.findById(org, { email: 1, name: 1 }).lean();
    if (o?.email)
      sendEmail(
        o.email,
        `New seller registration: ${d.brand} (${d.businessName})`,
        `${d.contactName} registered ${d.businessName} (brand ${d.brand}) to sell on your store.\n\nPhone: ${phone}\nEmail: ${email}\nGSTIN: ${d.gstin || "—"}\nPickup: ${d.city}, ${d.pincode}\nCategories: ${d.categories || "—"}\nProducts: ${d.productCount || "—"}\n${d.message ? `\n${d.message}\n` : ""}\nApprove or reject it in OrdexaGo: Store → Sellers → Registrations.`,
      ).catch(() => {});
    sendEmail(
      email,
      `We've received your seller registration`,
      `Hi ${d.contactName},\n\nThank you for registering ${d.brand} to sell on WoodenTwist. Our team will review your details and get back to you within a few working days.\n\nOnce approved, you'll get a login to your seller dashboard, where you can upload your product listings.`,
    ).catch(() => {});
    res
      .status(201)
      .send({
        ok: true,
        id: String(s._id),
        message:
          "Thank you! We've received your registration. Our team will review it and email you soon.",
      });
  } catch (e) {
    console.error(`[seller register] ${e.message}`);
    res.status(500).send({ error: "Something went wrong. Please try again." });
  }
});

module.exports = router;
