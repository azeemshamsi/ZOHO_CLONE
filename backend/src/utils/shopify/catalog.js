/**
 * Shopify order lines → MGI items, with HSN and GST rate checked against category rules.
 * Shopify prices are GST inclusive; MGI item rates are exclusive.
 */
const Item = require("../../models/Item");

const DEFAULT_RULES = [
  // Checked in this order: furnishing and kitchen words first, so "table runner" or "bed sheet" isn't furniture.
  {
    name: "Home furnishing",
    taxRate: 5,
    defaultHsn: "6304",
    hsnPrefixes: ["5701", "5702", "5703", "5705", "6301", "6302", "6303", "6304", "6305", "6306", "6307", "9404"],
    keywords: ["home furnishing", "furnishing", "linens", "bedding", "bedsheet", "bed sheet", "bedspread", "bed cover", "duvet", "quilt", "comforter", "blanket", "dohar", "pillow", "cushion", "curtain", "drape", "rug", "carpet", "dhurrie", "durrie", "runner", "table cover", "tablecloth", "table linen", "placemat", "napkin", "towel", "doormat", "door mat", "bath mat", "throw"],
  },
  {
    name: "Kitchenware",
    taxRate: 5,
    defaultHsn: "4419",
    hsnPrefixes: ["4419", "7323", "7615", "7418", "6911", "6912", "7013", "3924", "8215", "4602"],
    keywords: ["kitchenware", "kitchen", "cookware", "tableware", "dinnerware", "serveware", "servingware", "utensil", "chopping board", "cutting board", "cheese board", "platter", "serving", "tray", "bowl", "plate", "spoon", "spatula", "ladle", "turner", "fork", "rolling pin", "belan", "chakla", "masala", "spice box", "spice", "container", "jar", "mug", "cup", "glass", "tumbler", "kadai", "tawa", "pan", "pot holder", "coaster", "cutlery", "napkin holder", "salad"],
  },
  {
    name: "Furniture",
    taxRate: 18,
    defaultHsn: "9403",
    hsnPrefixes: ["9401", "9403"],
    keywords: ["furniture", "sofa", "couch", "bed", "cot", "diwan", "divan", "table", "chair", "stool", "bench", "cabinet", "wardrobe", "almirah", "bookshelf", "book shelf", "bookcase", "shelf", "shelves", "rack", "dresser", "drawer", "chest", "sideboard", "console", "ottoman", "pouffe", "desk", "tv unit", "tv stand", "shoe rack", "recliner", "settee", "swing", "jhula", "crib", "cradle", "nightstand", "bedside", "hutch", "trolley", "bar cabinet"],
  },
  {
    name: "Home decor",
    taxRate: 5,
    defaultHsn: "4420",
    hsnPrefixes: ["4420", "4414", "6913", "8306", "6702", "9701", "9405", "9105", "7009"],
    keywords: ["home decor", "decor", "décor", "decorative", "wall art", "wall hanging", "wall decor", "showpiece", "figurine", "idol", "statue", "sculpture", "vase", "planter", "candle", "lantern", "photo frame", "frame", "mirror", "clock", "key holder", "handicraft", "artifact", "artefact", "ornament", "bookend", "diya", "torans", "toran", "dreamcatcher"],
  },
];

const VALID_RATES = [0, 0.25, 3, 5, 12, 18, 28, 40];
const rulesOf = (store) => (store.rules && store.rules.length ? store.rules : DEFAULT_RULES);
const words = (s) => ` ${String(s || "").toLowerCase().replace(/[^a-z0-9é]+/g, " ")} `;
const has = (text, kw) => text.includes(` ${String(kw).toLowerCase().replace(/[^a-z0-9é]+/g, " ").trim()} `) || text.includes(` ${String(kw).toLowerCase().replace(/[^a-z0-9é]+/g, " ").trim()}s `);

// Which rule a product falls under: product type / Shopify category / tags first, then the title.
function categorize(line, rules) {
  const strong = words([line.productType, line.category, ...(line.tags || [])].join(" | "));
  const title = words(`${line.title} ${line.variantTitle || ""}`);
  for (const text of [strong, title]) for (const r of rules) if (r.keywords.some((k) => has(text, k))) return r;
  // No words matched: the HSN itself may say what it is.
  const h = String(line.hsn || "");
  if (h.length >= 4) return rules.find((r) => r.hsnPrefixes.some((p) => h.startsWith(p))) || null;
  return null;
}

const validHsn = (h) => /^\d{4}(\d{2}){0,2}$/.test(String(h || ""));

// The HSN and GST rate an item should have, with notes on anything changed.
function checkGst(line, store) {
  const rules = rulesOf(store);
  const rule = categorize(line, rules);
  const notes = [];
  let hsn = String(line.hsn || "").replace(/\D/g, "");
  let taxRate;
  let review = false;
  const shopifyRate = line.shopifyTaxRate || null;
  if (rule) {
    if (!validHsn(hsn)) {
      notes.push(hsn ? `HSN "${line.hsn}" isn't valid; used ${rule.defaultHsn} (${rule.name})` : `No HSN in Shopify; used ${rule.defaultHsn} (${rule.name})`);
      hsn = rule.defaultHsn;
    } else if (rule.hsnPrefixes.length && !rule.hsnPrefixes.some((p) => hsn.startsWith(p))) {
      notes.push(`HSN ${hsn} doesn't belong to ${rule.name}; changed to ${rule.defaultHsn}`);
      hsn = rule.defaultHsn;
    }
    taxRate = rule.taxRate;
    if (shopifyRate !== null && shopifyRate !== rule.taxRate) notes.push(`GST ${shopifyRate}% in Shopify changed to ${rule.taxRate}% (${rule.name})`);
  } else {
    review = true;
    if (!validHsn(hsn)) {
      notes.push(hsn ? `HSN "${line.hsn}" isn't valid — add the right HSN` : "No HSN — add one");
      hsn = "";
    }
    taxRate = shopifyRate !== null && VALID_RATES.includes(shopifyRate) ? shopifyRate : store.fallbackTaxRate ?? 18;
    notes.push(`Category not recognised; GST ${taxRate}% ${shopifyRate !== null && VALID_RATES.includes(shopifyRate) ? "taken from Shopify" : "is the default"} — please check`);
  }
  return { hsn, taxRate, category: rule?.name || "", notes, review: review || notes.length > 0 };
}

const itemName = (l) => (l.variantTitle ? `${l.title} - ${l.variantTitle}` : l.title).slice(0, 200);
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Find or create the MGI item for an order line. Existing items keep their (already checked) HSN and rate.
async function itemFor(orgId, line, store, cache = new Map()) {
  const key = line.variantId || line.sku || itemName(line);
  if (cache.has(key)) return cache.get(key);
  let item = null;
  // A Shopify listing linked to an MGI item (e.g. 4 listings of one metal table) uses that item.
  if (line.variantId) item = await Item.findOne({ organization: orgId, "shopifyLinks.variantId": line.variantId });
  if (!item && line.variantId) item = await Item.findOne({ organization: orgId, shopifyVariantId: line.variantId, active: { $ne: false } });
  if (!item && line.sku) item = await Item.findOne({ organization: orgId, sku: new RegExp(`^${esc(line.sku)}$`, "i") });
  if (!item) item = await Item.findOne({ organization: orgId, name: new RegExp(`^${esc(itemName(line))}$`, "i") });
  let created = false;
  if (!item) {
    const g = checkGst(line, store);
    const incl = line.unitPrice || 0;
    item = await Item.create({
      organization: orgId,
      type: "goods",
      name: itemName(line),
      sku: line.sku || "",
      unit: "pcs",
      hsnSac: g.hsn,
      taxRate: g.taxRate,
      rate: Math.round((incl / (1 + g.taxRate / 100)) * 100) / 100,
      description: [line.productType, g.category && g.category !== line.productType ? g.category : ""].filter(Boolean).join(" · "),
      trackInventory: store.invoice?.trackInventory !== false,
      category: g.category || line.productType || "",
      image: line.image || "",
      shopifyVariantId: line.variantId || "",
      needsReview: g.review,
      reviewNote: g.notes.join("; "),
    });
    created = true;
  } else if (line.variantId && !item.shopifyVariantId && !(item.shopifyLinks || []).some((l) => l.variantId === line.variantId)) {
    item.shopifyVariantId = line.variantId;
    if (!item.image && line.image) item.image = line.image;
    await item.save();
  } else if (!item.image && line.image) {
    await Item.updateOne({ _id: item._id }, { image: line.image });
  }
  const out = { item, created };
  cache.set(key, out);
  return out;
}

module.exports = { DEFAULT_RULES, VALID_RATES, rulesOf, categorize, checkGst, itemFor, itemName };
