// Seller onboarding: website registration (pending → approve / reject), the brand's collection on Shopify,
// listing files (validation by row) → draft products → approved at our price.
const test = require("node:test");
const assert = require("node:assert");
const express = require("express");
const mongoose = require("mongoose");
const mails = [];
require("../src/utils/mailer").sendSystemMail = async (to, subject) => (
  mails.push({ to, subject }),
  true
);
const client = require("../src/utils/shopify/client");
const calls = [];
let existingCollection = null;
client.gql = async (store, q, v) => {
  calls.push({ q, v });
  if (q.includes("publications("))
    return {
      publications: {
        nodes: [
          { id: "PUB-POS", catalog: { title: "Point of Sale" } },
          { id: "PUB-OS", catalog: { title: "Online Store" } },
        ],
      },
    };
  if (q.includes("publishablePublish"))
    return { publishablePublish: { userErrors: [] } };
  if (q.includes("collections("))
    return {
      collections: { nodes: existingCollection ? [existingCollection] : [] },
    };
  if (q.includes("collectionCreate"))
    return {
      collectionCreate: {
        collection: {
          id: "gid://shopify/Collection/77",
          handle: v.input.title.toLowerCase().replace(/\W+/g, "-"),
        },
        userErrors: [],
      },
    };
  if (q.includes("productVariants("))
    return {
      productVariants: {
        nodes: [{ sku: "TAKEN-1", product: { title: "Old shelf" } }],
      },
    };
  if (q.includes("productSet"))
    return {
      productSet: {
        product: {
          id: "gid://shopify/Product/500",
          handle: v.input.handle,
          variants: {
            nodes: v.input.variants.map((x, i) => ({
              id: `gid://shopify/ProductVariant/${i + 1}`,
              sku: x.inventoryItem.sku,
            })),
          },
        },
        userErrors: [],
      },
    };
  if (q.includes("product(id"))
    return {
      product: {
        id: v.id,
        status: "DRAFT",
        variants: {
          nodes: [
            {
              id: "gid://shopify/ProductVariant/1",
              sku: "ABC-CT-001",
              price: "8999.00",
              compareAtPrice: "12999.00",
            },
          ],
        },
      },
    };
  if (q.includes("productVariantsBulkUpdate"))
    return { productVariantsBulkUpdate: { userErrors: [] } };
  if (q.includes("productUpdate"))
    return {
      productUpdate: {
        product: { id: v.p.id, status: "ACTIVE" },
        userErrors: [],
      },
    };
  throw new Error("unexpected " + q.slice(0, 50));
};
const ShopifyStore = require("../src/models/ShopifyStore");
const store = {
  _id: new mongoose.Types.ObjectId(),
  shop: "woodentwist.myshopify.com",
  connected: true,
  organization: new mongoose.Types.ObjectId(),
  locationId: "gid://shopify/Location/1",
};
ShopifyStore.findOne = (f) => {
  const ok = !f.shop || f.shop === store.shop;
  const p = Promise.resolve(ok ? store : null);
  p.lean = async () => (ok ? store : null);
  return p;
};
const Organization = require("../src/models/Organization");
Organization.findById = () => ({
  lean: async () => ({ email: "team@woodentwist.com", name: "Shiraz" }),
});
const Seller = require("../src/models/Seller");
const sellers = [];
Seller.find = (f) => ({
  lean: async () =>
    sellers.filter(
      (s) =>
        !f.status ||
        (f.status.$ne ? s.status !== f.status.$ne : s.status === f.status),
    ),
});
Seller.create = async (d) => {
  const s = { _id: new mongoose.Types.ObjectId(), ...d };
  sellers.push(s);
  return s;
};
Seller.updateOne = async () => ({});
const L = require("../src/utils/sellerListings");
const B = require("../src/utils/shopify/brands");

const app = express();
app.set("trust proxy", true);
app.use(
  "/reg",
  express.json(),
  express.text({ type: "text/plain" }),
  require("../src/routes/publicSellers"),
);
const srv = app.listen(0);
const url = `http://127.0.0.1:${srv.address().port}/reg`;
test.after(() => srv.close());
const form = {
  shop: "woodentwist.myshopify.com",
  brand: "Craft Villa",
  businessName: "Craft Villa Exports",
  contactName: "Imran",
  email: "Imran@CraftVilla.in",
  phone: "+91 98765 43210",
  gstin: "09ABCDE1234F1Z5",
  pan: "",
  address: "12 Industrial Area, Delhi Road",
  city: "Saharanpur",
  state: "Uttar Pradesh",
  pincode: "247001",
  categories: "Wall shelves, trays",
  productCount: "50-100",
  website: "",
  message: "",
  agree: true,
  company_url: "",
};
const post = (body, headers = {}) =>
  fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://woodentwist.com",
      ...headers,
    },
    body: JSON.stringify(body),
  });

test("website registration: CORS, validation, pending seller, emails, no duplicates", async () => {
  const pre = await fetch(url, {
    method: "OPTIONS",
    headers: {
      Origin: "https://woodentwist.com",
      "Access-Control-Request-Method": "POST",
    },
  });
  assert.strictEqual(pre.status, 204);
  assert.strictEqual(
    pre.headers.get("access-control-allow-origin"),
    "https://woodentwist.com",
  );
  let r = await post(
    { ...form, pincode: "2470" },
    { "X-Forwarded-For": "1.1.1.1" },
  );
  assert.strictEqual(r.status, 400);
  assert.match((await r.json()).error, /Pincode/);
  r = await post(
    { ...form, company_url: "http://spam" },
    { "X-Forwarded-For": "1.1.1.2" },
  );
  assert.strictEqual(r.status, 200); // bot: quietly ignored
  assert.strictEqual(sellers.length, 0);
  r = await post(form, { "X-Forwarded-For": "1.1.1.3" });
  assert.strictEqual(r.status, 201);
  const s = sellers[0];
  assert.deepStrictEqual(
    [
      s.status,
      s.active,
      s.brands.length,
      s.email,
      s.phone,
      s.pickup.state,
      s.application.brand,
    ],
    [
      "pending",
      false,
      0,
      "imran@craftvilla.in",
      "9876543210",
      "09",
      "Craft Villa",
    ],
  );
  assert.deepStrictEqual(mails.map((m) => m.to).sort(), [
    "imran@craftvilla.in",
    "team@woodentwist.com",
  ]);
  r = await post(
    { ...form, email: "other@x.in" },
    { "X-Forwarded-For": "1.1.1.4" },
  );
  assert.strictEqual(r.status, 409); // same phone / GSTIN
  r = await post(
    {
      ...form,
      shop: "someone.myshopify.com",
      email: "a@b.in",
      phone: "9123456789",
      gstin: "",
    },
    { "X-Forwarded-For": "1.1.1.5" },
  );
  assert.strictEqual(r.status, 400);
});

test("brand on Shopify: a Vendor collection, created once and published to the Online Store", async () => {
  calls.length = 0;
  const r = await B.ensureBrand(store, "Craft Villa");
  assert.deepStrictEqual([r.created, r.published], [true, true]);
  const create = calls.find((c) => c.q.includes("collectionCreate"));
  assert.deepStrictEqual(create.v.input.ruleSet.rules, [
    { column: "VENDOR", relation: "EQUALS", condition: "Craft Villa" },
  ]);
  assert.deepStrictEqual(
    calls.find((c) => c.q.includes("publishablePublish")).v.p,
    [{ publicationId: "PUB-OS" }],
  );
  existingCollection = {
    id: "gid://shopify/Collection/5",
    handle: "craft-villa",
    title: "Craft Villa",
    ruleSet: {
      rules: [
        { column: "VENDOR", relation: "EQUALS", condition: "craft villa" },
      ],
    },
  };
  calls.length = 0;
  const again = await B.ensureBrand(store, "Craft Villa");
  assert.deepStrictEqual(
    [again.created, again.id],
    [false, "gid://shopify/Collection/5"],
  );
  assert.ok(!calls.some((c) => c.q.includes("collectionCreate")));
});

const seller = {
  _id: new mongoose.Types.ObjectId(),
  organization: store.organization,
  name: "ABC Decor",
  brands: ["ABC Decor"],
};
const toB64 = (rows) => {
  const XLSX = require("xlsx");
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(rows, { header: L.HEADERS }),
    "Listings",
  );
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }).toString(
    "base64",
  );
};
const good = {
  Handle: "x",
  Title: "Sheesham Wood Wall Shelf Set of 3",
  "Body (HTML)":
    "Three floating shelves in solid sheesham wood, with hidden brackets and screws included.",
  Type: "Wall Shelf",
  "Variant SKU": "abc-ws-01",
  "Variant Grams": 2500,
  "Variant Inventory Qty": 5,
  "Variant Price": 1999,
  "Variant Compare At Price": 2999,
  "Cost per item": 1200,
  "Image Src": "https://cdn.example.com/a.jpg",
  "HSN Code": 9403,
  "GST %": 18,
  "Length (cm)": 60,
  "Width (cm)": 20,
  "Height (cm)": 10,
};

test("listing file: every problem by row; SKUs on Shopify or repeated are refused", async () => {
  const SellerListing = require("../src/models/SellerListing");
  SellerListing.find = () => ({ lean: async () => [] });
  const b64 = toB64([
    good,
    {
      ...good,
      Handle: "y",
      Title: "SHORT",
      "Variant SKU": "ABC-WS-01",
      "Image Src": "https://drive.google.com/file/d/1",
      "GST %": 7,
    },
    { ...good, Handle: "z", "Variant SKU": "TAKEN-1", Vendor: "Other Brand" },
    {
      Handle: "q",
      Title: "Cotton Cushion Cover Set of Five",
      "Body (HTML)": "x".repeat(60),
      Type: "Cushion",
      "Option1 Name": "Color",
      "Option1 Value": "Blue",
      "Variant SKU": "Q1",
      "Variant Grams": 500,
      "Variant Inventory Qty": 1,
      "Variant Price": 500,
      "Cost per item": 300,
      "Image Src": "https://cdn.example.com/q.jpg",
      "HSN Code": "6304",
      "GST %": 12,
      "Length (cm)": 1,
      "Width (cm)": 1,
      "Height (cm)": 1,
    },
    {
      Handle: "q",
      "Option1 Value": "Blue",
      "Variant SKU": "Q2",
      "Variant Grams": 500,
      "Variant Inventory Qty": 1,
      "Variant Price": 500,
      "Cost per item": 300,
    },
  ]);
  const r = await L.check(seller, b64);
  const by = (h) =>
    r.problems
      .filter((p) => p.handle === h)
      .map((p) => p.message)
      .join(" | ");
  assert.deepStrictEqual(
    r.products.map((p) => [p.handle, p.ok]),
    [
      ["x", true],
      ["y", false],
      ["z", false],
      ["q", false],
    ],
  );
  assert.match(by("y"), /Title must be 10–150/);
  assert.match(by("y"), /Google Drive/);
  assert.match(by("y"), /GST %/);
  assert.match(by("x") + by("y"), /ABC-WS-01 is used by another product/);
  assert.match(by("z"), /isn't your brand/);
  assert.match(by("z"), /TAKEN-1 is already on the website/);
  assert.match(by("q"), /both "Blue"/);
  const ok = await L.check(seller, toB64([good]));
  assert.deepStrictEqual(
    [
      ok.problems,
      ok.products[0].ok,
      ok.products[0].variants[0].sku,
      ok.products[0].brand,
    ],
    [[], true, "ABC-WS-01", "ABC Decor"],
  );
});

test("draft on Shopify, then approved at our price and published", async () => {
  const { products } = L.buildProducts(
    L.readRows(L.sampleXlsx(seller).toString("base64")),
    seller,
  );
  const l = {
    _id: new mongoose.Types.ObjectId(),
    sellerName: "ABC Decor",
    ...products[0],
  };
  calls.length = 0;
  const p = await L.createDraft(store, l);
  const input = calls.find((c) => c.q.includes("productSet")).v.input;
  assert.deepStrictEqual(
    [
      input.status,
      input.vendor,
      input.productOptions[0].name,
      input.variants[0].optionValues[0].name,
      input.variants[0].inventoryItem.cost,
      input.variants[0].inventoryQuantities[0].quantity,
      input.files.length,
    ],
    ["DRAFT", "ABC Decor", "Title", "Default Title", "6000", 10, 2],
  );
  assert.ok(input.tags.includes("seller-listing"));
  assert.strictEqual(p.id, "gid://shopify/Product/500");
  const doc = {
    ...l,
    organization: store.organization,
    shopifyId: p.id,
    status: "draft",
    markModified() {},
    save: async () => {},
  };
  calls.length = 0;
  const r = await L.approve(
    doc,
    [{ sku: "ABC-CT-001", price: 9499, compareAtPrice: 13999 }],
    { _id: "u", name: "Sana" },
  );
  assert.strictEqual(r.published, true);
  assert.deepStrictEqual(
    calls.find((c) => c.q.includes("productVariantsBulkUpdate")).v.v,
    [
      {
        id: "gid://shopify/ProductVariant/1",
        price: "9499",
        compareAtPrice: "13999",
      },
    ],
  );
  assert.strictEqual(
    calls.find((c) => c.q.includes("productUpdate")).v.p.status,
    "ACTIVE",
  );
  assert.deepStrictEqual(
    [doc.status, doc.variants[0].finalPrice, doc.reviewedByName],
    ["approved", 9499, "Sana"],
  );
  await assert.rejects(
    L.approve(
      { ...doc, status: "draft" },
      [{ sku: "ABC-CT-001", price: 9000, compareAtPrice: 100 }],
      {},
    ),
    /MRP/,
  );
});
