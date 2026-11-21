/**
 * Seller listing files → draft products on Shopify.
 *
 * The file follows Shopify's product CSV (same column names, one row per variant / extra image, rows of one product
 * share its Handle), plus a few columns we need for shipping and GST. Sellers download a sample (.xlsx with a
 * Guidelines sheet) from their dashboard, upload it back (.xlsx or .csv), see every problem by row, and submit the
 * valid products. Each becomes a DRAFT product on Shopify (Vendor = the seller's brand, tagged "seller-listing");
 * the team reviews it in Store → Sellers → Listings, sets the selling price and approves (active + on the website)
 * or rejects it.
 */
const crypto = require("crypto");
const XLSX = require("xlsx");
const SellerListing = require("../models/SellerListing");
const ShopifyStore = require("../models/ShopifyStore");
const Seller = require("../models/Seller");

// [column, required, help]
const COLUMNS = [
  [
    "Handle",
    "yes",
    "The product's web address name: lowercase letters, numbers and hyphens (e.g. sheesham-wood-coffee-table). Every row of the same product has the same Handle. Leave blank to make it from the Title.",
  ],
  [
    "Title",
    "yes (first row)",
    "Product name buyers see, 10–150 characters: what it is, material, key feature (e.g. Sheesham Wood Coffee Table with Storage Shelf). No ALL CAPS, no prices or offers, no phone numbers or links.",
  ],
  [
    "Body (HTML)",
    "yes (first row)",
    "Description, at least 50 characters: material, finish, size, what's in the box, care. Plain text is fine; simple HTML (<p>, <ul><li>, <b>) is allowed.",
  ],
  [
    "Vendor",
    "yes",
    "Your brand, exactly as approved by us. Blank = your brand.",
  ],
  [
    "Type",
    "yes (first row)",
    "Product type, e.g. Coffee Table, Wall Shelf, Bed Sheet.",
  ],
  [
    "Tags",
    "",
    "Comma-separated search words, e.g. sheesham, living room, storage.",
  ],
  [
    "Option1 Name",
    "",
    "Only for products with choices (variants), e.g. Color or Size. Leave blank for a single product.",
  ],
  ["Option1 Value", "", "This row's value for Option1, e.g. Walnut."],
  ["Option2 Name", "", "A second choice, e.g. Size."],
  ["Option2 Value", "", "This row's value for Option2."],
  ["Option3 Name", "", "A third choice."],
  ["Option3 Value", "", "This row's value for Option3."],
  [
    "Variant SKU",
    "yes",
    "Your unique code for this product / variant. Never reuse a SKU — it identifies the product in orders, stock and payments.",
  ],
  ["Variant Grams", "yes", "Packed weight in grams (1.5 kg = 1500)."],
  ["Variant Inventory Qty", "yes", "Stock you can ship now (0 or more)."],
  [
    "Variant Price",
    "yes",
    "Your suggested selling price in ₹, GST included. We set the final price on the website.",
  ],
  [
    "Variant Compare At Price",
    "",
    "MRP in ₹ (higher than the selling price), shown struck through.",
  ],
  [
    "Cost per item",
    "yes",
    "Your price to WoodenTwist in ₹ (what you're paid for one piece), GST included.",
  ],
  ["Variant Barcode", "", "EAN / UPC barcode, if the product has one."],
  [
    "Image Src",
    "yes",
    "A direct, public https link to a product image (.jpg, .png or .webp) — at least one per product, ideally 4–8: white background first, then lifestyle and close-ups, min 1000×1000 px. Extra images go on extra rows with the same Handle and only Image Src filled. Google Drive / WhatsApp links don't work.",
  ],
  ["Image Position", "", "Order of the image (1 = main image)."],
  [
    "Image Alt Text",
    "",
    "Short description of the image for accessibility and search.",
  ],
  [
    "SEO Title",
    "",
    "Title for Google, up to 70 characters. Blank = the Title.",
  ],
  ["SEO Description", "", "Description for Google, up to 320 characters."],
  ["HSN Code", "yes", "HSN code of the product, 4 to 8 digits (e.g. 9403)."],
  ["GST %", "yes", "GST rate: 0, 3, 5, 12, 18 or 28."],
  ["Length (cm)", "yes", "Packed box length in cm."],
  ["Width (cm)", "yes", "Packed box width in cm."],
  ["Height (cm)", "yes", "Packed box height in cm."],
];
const HEADERS = COLUMNS.map((c) => c[0]);

const SAMPLE = [
  {
    Handle: "sheesham-wood-coffee-table-with-shelf",
    Title: "Sheesham Wood Coffee Table with Storage Shelf",
    "Body (HTML)":
      "<p>Solid sheesham wood coffee table with a lower shelf for books and magazines. Honey finish, rounded edges.</p><ul><li>Size: 90 x 50 x 45 cm</li><li>Easy assembly, tools included</li></ul>",
    Vendor: "",
    Type: "Coffee Table",
    Tags: "sheesham, coffee table, living room",
    "Variant SKU": "ABC-CT-001",
    "Variant Grams": 14000,
    "Variant Inventory Qty": 10,
    "Variant Price": 8999,
    "Variant Compare At Price": 12999,
    "Cost per item": 6000,
    "Image Src": "https://example.com/images/coffee-table-front.jpg",
    "Image Position": 1,
    "Image Alt Text": "Sheesham wood coffee table front view",
    "HSN Code": "9403",
    "GST %": 18,
    "Length (cm)": 95,
    "Width (cm)": 55,
    "Height (cm)": 20,
  },
  {
    Handle: "sheesham-wood-coffee-table-with-shelf",
    "Image Src": "https://example.com/images/coffee-table-room.jpg",
    "Image Position": 2,
    "Image Alt Text": "Coffee table in a living room",
  },
  {
    Handle: "cotton-cushion-cover-set-of-5",
    Title: "Cotton Printed Cushion Cover Set of 5, 16 x 16 inch",
    "Body (HTML)":
      "<p>Set of 5 cotton cushion covers with a hidden zip. Soft, fade-resistant print, machine washable.</p>",
    Type: "Cushion Cover",
    Tags: "cushion cover, cotton, set of 5",
    "Option1 Name": "Color",
    "Option1 Value": "Blue",
    "Variant SKU": "ABC-CC-BLU",
    "Variant Grams": 600,
    "Variant Inventory Qty": 25,
    "Variant Price": 999,
    "Variant Compare At Price": 1499,
    "Cost per item": 550,
    "Image Src": "https://example.com/images/cushion-blue.jpg",
    "Image Position": 1,
    "HSN Code": "6304",
    "GST %": 12,
    "Length (cm)": 30,
    "Width (cm)": 25,
    "Height (cm)": 5,
  },
  {
    Handle: "cotton-cushion-cover-set-of-5",
    "Option1 Value": "Grey",
    "Variant SKU": "ABC-CC-GRY",
    "Variant Grams": 600,
    "Variant Inventory Qty": 20,
    "Variant Price": 999,
    "Variant Compare At Price": 1499,
    "Cost per item": 550,
    "Image Src": "https://example.com/images/cushion-grey.jpg",
    "Image Position": 2,
    "HSN Code": "6304",
    "GST %": 12,
    "Length (cm)": 30,
    "Width (cm)": 25,
    "Height (cm)": 5,
  },
];

function sampleXlsx(seller) {
  const brand = seller?.brands?.[0] || "Your Brand";
  const wb = XLSX.utils.book_new();
  const rows = SAMPLE.map((r) => ({
    ...r,
    Vendor: r.Title ? brand : r.Vendor || "",
  }));
  const ws = XLSX.utils.json_to_sheet(rows, { header: HEADERS });
  ws["!cols"] = HEADERS.map((h) => ({
    wch: Math.min(40, Math.max(12, h.length + 2)),
  }));
  XLSX.utils.book_append_sheet(wb, ws, "Listings");
  const g = XLSX.utils.aoa_to_sheet([
    ["How to fill the listing file"],
    [
      "Delete the example rows, add your products and upload the file from your dashboard → Listings. You can save it as .xlsx or .csv.",
    ],
    [
      "Rows of one product share its Handle: the first row has the product details; each extra row is another variant (Option values + SKU + price) or another image (only Image Src).",
    ],
    [
      "Your products are created as drafts. We check them, set the selling price and make them live — you'll see the status in your dashboard.",
    ],
    [],
    ["Column", "Required", "What to enter"],
    ...COLUMNS,
    [],
    ["Product guidelines"],
    [
      "• Only products you make or are allowed to sell; no counterfeit or restricted items.",
    ],
    [
      "• Real photos of the actual product; no watermarks, logos, prices or text on images; main image on a plain white background.",
    ],
    [
      "• Titles and descriptions must be accurate: material, size and colour as delivered.",
    ],
    [
      "• Weight and box size must be of the packed product — they decide the shipping charge.",
    ],
  ]);
  g["!cols"] = [{ wch: 26 }, { wch: 16 }, { wch: 120 }];
  XLSX.utils.book_append_sheet(wb, g, "Guidelines");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}

const slug = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
const num = (v) => {
  if (v === "" || v == null) return null;
  const n = Number(String(v).replace(/[₹,\s]/g, ""));
  return Number.isFinite(n) ? n : NaN;
};
const str = (v) => String(v ?? "").trim();
const stripTags = (h) =>
  String(h || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
// Description: plain text becomes paragraphs; only simple tags are kept.
function cleanHtml(h) {
  const s = str(h);
  if (!/<[a-z]/i.test(s))
    return s
      .split(/\n{2,}/)
      .map(
        (p) =>
          `<p>${p.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c]).replace(/\n/g, "<br>")}</p>`,
      )
      .join("");
  return s
    .replace(/<(script|style|iframe|object|embed)[\s\S]*?<\/\1>/gi, "")
    .replace(
      /<(?!\/?(p|br|ul|ol|li|b|strong|i|em|h[2-6]|table|tr|td|th|tbody|thead|span)\b)[^>]*>/gi,
      "",
    )
    .replace(/\son\w+="[^"]*"/gi, "");
}

// Read the uploaded file (base64 .xlsx / .csv) → rows keyed by our column names, with their row numbers.
function readRows(base64) {
  const buf = Buffer.from(
    String(base64 || "").replace(/^data:[^,]*,/, ""),
    "base64",
  );
  if (!buf.length) throw new Error("The file is empty");
  let wb;
  try {
    wb = XLSX.read(buf, { type: "buffer", raw: false, codepage: 65001 });
  } catch {
    throw new Error(
      "Couldn't read the file — upload the .xlsx or .csv listing file",
    );
  }
  const name =
    wb.SheetNames.find((n) => /listing/i.test(n)) || wb.SheetNames[0];
  const ws = wb.Sheets[name];
  const aoa = XLSX.utils.sheet_to_json(ws, {
    header: 1,
    defval: "",
    raw: true,
    blankrows: false,
  });
  const hi = aoa.findIndex((r) =>
    r.some((c) => /^(handle|title)$/i.test(str(c))),
  );
  if (hi < 0)
    throw new Error(
      "The file has no header row — start from the sample listing file",
    );
  const head = aoa[hi].map((h) => {
    const k = str(h).toLowerCase();
    return (
      HEADERS.find((x) => x.toLowerCase() === k) ||
      (k === "width (cm)" || k === "breadth (cm)"
        ? "Width (cm)"
        : k === "body html" || k === "description"
          ? "Body (HTML)"
          : str(h))
    );
  });
  const missing = ["Title", "Variant SKU", "Variant Price", "Image Src"].filter(
    (c) => !head.includes(c),
  );
  if (missing.length)
    throw new Error(
      `Columns missing: ${missing.join(", ")} — start from the sample listing file`,
    );
  const rows = [];
  for (let i = hi + 1; i < aoa.length; i++) {
    const r = {};
    head.forEach((h, j) => (r[h] = aoa[i][j]));
    if (Object.values(r).every((v) => str(v) === "")) continue;
    rows.push({ n: i + 1, r });
  }
  if (!rows.length) throw new Error("No products in the file");
  if (rows.length > 3000)
    throw new Error("Up to 3,000 rows per file — split it into smaller files");
  return rows;
}

const GST = [0, 3, 5, 12, 18, 28];
const IMG = /^https:\/\/[^\s]+$/i;

// Rows → products, with every problem found. → { products, problems: [{ row, handle, message }] }
function buildProducts(rows, seller, brandChoice) {
  const brands = seller.brands || [];
  const problems = [];
  const byHandle = new Map();
  let last = null;
  for (const { n, r } of rows) {
    let handle = slug(r.Handle);
    if (!handle && str(r.Title)) handle = slug(r.Title);
    if (!handle && last) handle = last;
    if (!handle) {
      problems.push({ row: n, message: "No Handle or Title" });
      continue;
    }
    last = handle;
    if (!byHandle.has(handle))
      byHandle.set(handle, { handle, row: n, first: null, rows: [] });
    const p = byHandle.get(handle);
    if (str(r.Title) && !p.first) p.first = { n, r };
    p.rows.push({ n, r });
  }
  const products = [];
  for (const p of byHandle.values()) {
    const err = (row, message) =>
      problems.push({ row, handle: p.handle, message });
    const before = problems.length;
    if (!p.first) {
      err(p.row, "The first row of this product needs its Title");
      continue;
    }
    const f = p.first.r;
    const title = str(f.Title).replace(/\s+/g, " ");
    if (title.length < 10 || title.length > 150)
      err(p.first.n, `Title must be 10–150 characters (it's ${title.length})`);
    if (
      title.length > 12 &&
      title === title.toUpperCase() &&
      /[A-Z]/.test(title)
    )
      err(p.first.n, "Title in ALL CAPS — write it in normal case");
    if (/(https?:\/\/|www\.|\b\d{10}\b|₹|rs\.?\s?\d)/i.test(title))
      err(p.first.n, "Title can't have links, phone numbers or prices");
    const body = cleanHtml(f["Body (HTML)"]);
    if (stripTags(body).length < 50)
      err(p.first.n, "Description (Body) must be at least 50 characters");
    const type = str(f.Type);
    if (!type) err(p.first.n, "Type is required (e.g. Coffee Table)");
    let brand = str(f.Vendor) || brandChoice || brands[0] || "";
    const own = brands.find((b) => b.toLowerCase() === brand.toLowerCase());
    if (!own)
      err(
        p.first.n,
        brands.length
          ? `Vendor "${brand}" isn't your brand (${brands.join(", ")})`
          : "Your brand isn't set up yet — contact us",
      );
    else brand = own;
    const optNames = [f["Option1 Name"], f["Option2 Name"], f["Option3 Name"]]
      .map(str)
      .filter(Boolean);
    if (new Set(optNames.map((x) => x.toLowerCase())).size !== optNames.length)
      err(p.first.n, "Two options have the same name");
    // Variants: rows with a SKU, a price or an option value.
    const variants = [];
    const images = [];
    for (const { n, r } of p.rows) {
      const isVariant =
        str(r["Variant SKU"]) ||
        str(r["Variant Price"]) ||
        str(r["Option1 Value"]);
      if (isVariant) {
        const v = {
          row: n,
          sku: str(r["Variant SKU"]).toUpperCase(),
          options: optNames.map((_, i) => str(r[`Option${i + 1} Value`])),
          price: num(r["Variant Price"]),
          compareAtPrice: num(r["Variant Compare At Price"]),
          cost: num(r["Cost per item"]),
          grams: num(r["Variant Grams"]),
          qty: num(r["Variant Inventory Qty"]),
          barcode: str(r["Variant Barcode"]),
          hsn:
            str(r["HSN Code"] ?? f["HSN Code"]).replace(/\D/g, "") ||
            str(f["HSN Code"]).replace(/\D/g, ""),
          gst: num(str(r["GST %"]) !== "" ? r["GST %"] : f["GST %"]),
        };
        if (!v.sku) err(n, "Variant SKU is required");
        else if (!/^[A-Z0-9][A-Z0-9._/-]{1,49}$/.test(v.sku))
          err(
            n,
            `SKU "${v.sku}": use letters, numbers, - _ . / (2–50 characters)`,
          );
        if (!(v.price > 0)) err(n, "Variant Price must be more than 0");
        if (v.compareAtPrice != null && !(v.compareAtPrice >= v.price))
          err(n, "Compare At Price (MRP) must be at least the Variant Price");
        if (!(v.cost > 0))
          err(n, "Cost per item (your price to us) is required");
        else if (v.price > 0 && v.cost > v.price)
          err(n, "Cost per item is more than the Variant Price");
        if (!(v.grams > 0)) err(n, "Variant Grams (packed weight) is required");
        if (!(Number.isInteger(v.qty) && v.qty >= 0))
          err(n, "Variant Inventory Qty must be a whole number, 0 or more");
        if (!/^\d{4,8}$/.test(v.hsn)) err(n, "HSN Code must be 4 to 8 digits");
        if (!GST.includes(v.gst)) err(n, "GST % must be 0, 3, 5, 12, 18 or 28");
        optNames.forEach(
          (o, i) => !v.options[i] && err(n, `${o} value is missing`),
        );
        variants.push(v);
      }
      const src = str(r["Image Src"]);
      if (src) {
        if (!IMG.test(src)) err(n, "Image Src must be a full https:// link");
        else if (
          /drive\.google\.com|whatsapp|photos\.app\.goo\.gl|dropbox\.com\/s\//i.test(
            src,
          )
        )
          err(
            n,
            "Image link must be a direct image file (Google Drive / WhatsApp / Dropbox share links don't work)",
          );
        images.push({
          src,
          alt: str(r["Image Alt Text"]) || title,
          pos: num(r["Image Position"]) || 999 + images.length,
        });
      }
    }
    if (!variants.length) err(p.first.n, "No variant row (SKU and price)");
    if (!optNames.length && variants.length > 1)
      err(p.first.n, "Several variants need an Option1 Name (e.g. Color)");
    const combos = new Set();
    for (const v of variants) {
      const k = v.options.join(" / ").toLowerCase();
      if (combos.has(k) && optNames.length)
        err(v.row, `Two variants are both "${v.options.join(" / ")}"`);
      combos.add(k);
    }
    if (!images.length)
      err(p.first.n, "At least one image (Image Src) is required");
    if (images.length > 20) err(p.first.n, "Up to 20 images per product");
    const size = {
      length: num(f["Length (cm)"]),
      breadth: num(f["Width (cm)"]),
      height: num(f["Height (cm)"]),
    };
    if (!(size.length > 0 && size.breadth > 0 && size.height > 0))
      err(
        p.first.n,
        "Length, Width and Height (cm) of the packed box are required",
      );
    const tags = str(f.Tags)
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean)
      .slice(0, 40);
    products.push({
      row: p.first.n,
      handle: p.handle,
      title,
      descriptionHtml: body,
      brand,
      productType: type,
      tags,
      options: optNames.map((name, i) => ({
        name,
        values: [...new Set(variants.map((v) => v.options[i]).filter(Boolean))],
      })),
      variants: variants.map(({ row, ...v }) => v),
      images: images
        .sort((a, b) => a.pos - b.pos)
        .map(({ src, alt }) => ({ src, alt: alt.slice(0, 500) })),
      seoTitle: str(f["SEO Title"]).slice(0, 70),
      seoDescription: str(f["SEO Description"]).slice(0, 320),
      size,
      ok: problems.length === before,
    });
  }
  // SKUs used twice in the file.
  const seen = new Map();
  for (const p of products)
    for (const v of p.variants) {
      if (!v.sku) continue;
      if (seen.has(v.sku) && seen.get(v.sku) !== p.handle) {
        problems.push({
          row: p.row,
          handle: p.handle,
          message: `SKU ${v.sku} is used by another product in the file`,
        });
        p.ok = false;
      } else if (
        seen.has(v.sku) &&
        p.variants.filter((x) => x.sku === v.sku).length > 1
      ) {
        problems.push({
          row: p.row,
          handle: p.handle,
          message: `SKU ${v.sku} is used twice`,
        });
        p.ok = false;
      }
      seen.set(v.sku, p.handle);
    }
  return { products, problems };
}

// SKUs already on Shopify or already uploaded (not rejected) — a SKU identifies one product.
async function takenSkus(store, org, skus) {
  const taken = new Map();
  const listed = await SellerListing.find(
    { organization: org, status: { $nin: ["rejected", "failed"] } },
    { "variants.sku": 1, title: 1 },
  ).lean();
  const want = new Set(skus);
  for (const l of listed)
    for (const v of l.variants || [])
      if (want.has(v.sku)) taken.set(v.sku, `already uploaded (${l.title})`);
  if (store?.connected) {
    const { gql } = require("./shopify/client");
    const list = skus.filter((s) => !taken.has(s));
    for (let i = 0; i < list.length; i += 40) {
      const part = list.slice(i, i + 40);
      const q = part.map((s) => `sku:"${s.replace(/"/g, "")}"`).join(" OR ");
      try {
        const d = await gql(
          store,
          `query($q: String!) { productVariants(first: 100, query: $q) { nodes { sku product { title } } } }`,
          { q },
        );
        for (const v of d.productVariants?.nodes || [])
          if (v.sku && want.has(v.sku.toUpperCase()))
            taken.set(
              v.sku.toUpperCase(),
              `already on the website (${v.product?.title || ""})`,
            );
      } catch {
        /* checked again when the draft is created */
      }
    }
  }
  return taken;
}

// Check a file: products with their problems (nothing saved).
async function check(seller, base64, brandChoice) {
  const rows = readRows(base64);
  const { products, problems } = buildProducts(rows, seller, brandChoice);
  const store = await ShopifyStore.findOne({
    organization: seller.organization,
  });
  const taken = await takenSkus(
    store,
    seller.organization,
    products.flatMap((p) => p.variants.map((v) => v.sku)).filter(Boolean),
  );
  for (const p of products)
    for (const v of p.variants)
      if (taken.has(v.sku)) {
        problems.push({
          row: p.row,
          handle: p.handle,
          message: `SKU ${v.sku} is ${taken.get(v.sku)}`,
        });
        p.ok = false;
      }
  problems.sort((a, b) => a.row - b.row);
  return { products, problems, rows: rows.length };
}

// Save the valid products and start creating them on Shopify.
async function submit(seller, user, base64, fileName, brandChoice) {
  const r = await check(seller, base64, brandChoice);
  const good = r.products.filter((p) => p.ok);
  if (!good.length) return { ...r, batch: null, submitted: 0 };
  if (good.length > 500)
    throw new Error("Up to 500 products per upload — split the file");
  const batch = crypto.randomBytes(6).toString("hex");
  await SellerListing.insertMany(
    good.map(({ ok, ...p }) => ({
      ...p,
      organization: seller.organization,
      seller: seller._id,
      sellerName: seller.name,
      batch,
      fileName,
      submittedBy: user?._id,
      status: "queued",
    })),
  );
  processQueue(seller.organization).catch((e) =>
    console.error(`[listings] ${e.message}`),
  );
  return { ...r, batch, submitted: good.length };
}

/* ---------------- Shopify ---------------- */
async function createDraft(store, l) {
  const { gql } = require("./shopify/client");
  const { locationOf } = require("./sellers");
  const loc = await locationOf(store).catch(() => null);
  const opts = l.options?.length
    ? l.options
    : [{ name: "Title", values: ["Default Title"] }];
  const input = {
    title: l.title,
    handle: l.handle,
    descriptionHtml: l.descriptionHtml,
    vendor: l.brand,
    productType: l.productType,
    status: "DRAFT",
    tags: [
      ...new Set([
        ...(l.tags || []),
        "seller-listing",
        `seller:${l.sellerName}`.slice(0, 255),
      ]),
    ],
    ...(l.seoTitle || l.seoDescription
      ? {
          seo: {
            ...(l.seoTitle ? { title: l.seoTitle } : {}),
            ...(l.seoDescription ? { description: l.seoDescription } : {}),
          },
        }
      : {}),
    productOptions: opts.map((o) => ({
      name: o.name,
      values: o.values.map((name) => ({ name })),
    })),
    files: l.images.map((im) => ({
      originalSource: im.src,
      contentType: "IMAGE",
      alt: im.alt || l.title,
    })),
    metafields: [
      {
        namespace: "ordexago",
        key: "seller_listing",
        type: "single_line_text_field",
        value: String(l._id),
      },
      {
        namespace: "ordexago",
        key: "package_cm",
        type: "single_line_text_field",
        value: `${l.size?.length || 0}x${l.size?.breadth || 0}x${l.size?.height || 0}`,
      },
    ],
    variants: l.variants.map((v, i) => ({
      optionValues: l.options?.length
        ? l.options.map((o, j) => ({ optionName: o.name, name: v.options[j] }))
        : [{ optionName: "Title", name: "Default Title" }],
      price: String(v.price),
      ...(v.compareAtPrice ? { compareAtPrice: String(v.compareAtPrice) } : {}),
      position: i + 1,
      inventoryPolicy: "DENY",
      taxable: true,
      inventoryItem: {
        sku: v.sku,
        tracked: true,
        requiresShipping: true,
        cost: String(v.cost),
        ...(v.hsn ? { harmonizedSystemCode: v.hsn } : {}),
        measurement: { weight: { value: v.grams, unit: "GRAMS" } },
      },
      ...(loc
        ? {
            inventoryQuantities: [
              { locationId: loc, name: "available", quantity: v.qty || 0 },
            ],
          }
        : {}),
      metafields: [
        {
          namespace: "ordexago",
          key: "gst_rate",
          type: "number_integer",
          value: String(v.gst ?? 0),
        },
      ],
    })),
  };
  const r = await gql(
    store,
    `mutation($input: ProductSetInput!) { productSet(input: $input, synchronous: true) { product { id handle variants(first: 100) { nodes { id sku } } } userErrors { field message code } } }`,
    { input },
  );
  const errs = r.productSet?.userErrors || [];
  if (errs.length)
    throw new Error(
      errs
        .map((e) =>
          `${(e.field || []).slice(-2).join(".")}: ${e.message}`.replace(
            /^: /,
            "",
          ),
        )
        .join("; "),
    );
  const p = r.productSet.product;
  // Barcodes are set separately (the product model takes them per variant once it exists).
  const bySku = new Map(
    (p.variants?.nodes || []).map((v) => [
      String(v.sku || "").toUpperCase(),
      v.id,
    ]),
  );
  for (const v of l.variants)
    v.shopifyVariantId = bySku.get(v.sku) || v.shopifyVariantId;
  const withBarcode = l.variants.filter((v) => v.barcode && v.shopifyVariantId);
  if (withBarcode.length)
    await gql(
      store,
      `mutation($p: ID!, $v: [ProductVariantsBulkInput!]!) { productVariantsBulkUpdate(productId: $p, variants: $v) { userErrors { message } } }`,
      {
        p: p.id,
        v: withBarcode.map((v) => ({
          id: v.shopifyVariantId,
          barcode: v.barcode,
        })),
      },
    ).catch(() => {});
  return p;
}

const running = new Set();
// Create the queued listings on Shopify, one at a time (per company).
async function processQueue(org) {
  const k = String(org);
  if (running.has(k)) return;
  running.add(k);
  try {
    await SellerListing.updateMany(
      {
        organization: org,
        status: "creating",
        updatedAt: { $lt: new Date(Date.now() - 15 * 60000) },
      },
      { $set: { status: "queued" } },
    );
    const store = await ShopifyStore.findOne({ organization: org });
    for (;;) {
      const l = await SellerListing.findOne({
        organization: org,
        status: "queued",
      }).sort({ createdAt: 1 });
      if (!l) break;
      l.status = "creating";
      await l.save();
      try {
        if (!store?.connected)
          throw new Error("The Shopify store isn't connected");
        const p = await createDraft(store, l);
        l.shopifyId = p.id;
        l.shopifyHandle = p.handle;
        l.status = "draft";
        l.error = "";
        l.markModified("variants");
      } catch (e) {
        l.status = "failed";
        l.error = /scope|access denied/i.test(e.message)
          ? "The Shopify app needs the write_products scope — we'll retry once it's added"
          : e.message.slice(0, 500);
      }
      await l.save();
    }
  } finally {
    running.delete(k);
  }
}

// Approve: our prices on Shopify, made active and published on the website.
async function approve(l, prices, user) {
  const { gql } = require("./shopify/client");
  const store = await ShopifyStore.findOne({ organization: l.organization });
  if (!store?.connected) throw new Error("The Shopify store isn't connected");
  if (!l.shopifyId) throw new Error("This listing isn't on Shopify yet");
  // Variant ids (in case the draft was edited in Shopify).
  const d = await gql(
    store,
    `query($id: ID!) { product(id: $id) { id status variants(first: 100) { nodes { id sku price compareAtPrice } } } }`,
    { id: l.shopifyId },
  );
  if (!d.product) throw new Error("The draft product was deleted from Shopify");
  const bySku = new Map(
    d.product.variants.nodes.map((v) => [String(v.sku || "").toUpperCase(), v]),
  );
  const updates = [];
  for (const v of l.variants) {
    const want =
      (prices || []).find((x) => String(x.sku).toUpperCase() === v.sku) || {};
    const sv = bySku.get(v.sku);
    if (!sv) continue;
    const price = want.price > 0 ? want.price : Number(sv.price);
    const cmp =
      want.compareAtPrice > 0
        ? want.compareAtPrice
        : sv.compareAtPrice
          ? Number(sv.compareAtPrice)
          : null;
    if (cmp != null && cmp < price)
      throw new Error(
        `${v.sku}: MRP (compare-at) can't be below the selling price`,
      );
    v.finalPrice = price;
    v.finalCompareAt = cmp ?? undefined;
    v.shopifyVariantId = sv.id;
    updates.push({
      id: sv.id,
      price: String(price),
      compareAtPrice: cmp != null ? String(cmp) : null,
    });
  }
  if (updates.length) {
    const r = await gql(
      store,
      `mutation($p: ID!, $v: [ProductVariantsBulkInput!]!) { productVariantsBulkUpdate(productId: $p, variants: $v) { userErrors { field message } } }`,
      { p: l.shopifyId, v: updates },
    );
    const errs = r.productVariantsBulkUpdate?.userErrors || [];
    if (errs.length) throw new Error(errs.map((e) => e.message).join("; "));
  }
  const u = await gql(
    store,
    `mutation($p: ProductUpdateInput!) { productUpdate(product: $p) { product { id status } userErrors { message } } }`,
    { p: { id: l.shopifyId, status: "ACTIVE" } },
  );
  const ue = u.productUpdate?.userErrors || [];
  if (ue.length) throw new Error(ue.map((e) => e.message).join("; "));
  const { publish } = require("./shopify/brands");
  const pub = await publish(store, l.shopifyId);
  l.status = "approved";
  l.reviewedBy = user?._id;
  l.reviewedByName = user?.name || "";
  l.reviewedAt = new Date();
  l.reason = "";
  l.markModified("variants");
  await l.save();
  return { published: pub.published, note: pub.note || "" };
}

async function reject(l, reason, user, { deleteDraft = true } = {}) {
  if (deleteDraft && l.shopifyId) {
    const store = await ShopifyStore.findOne({ organization: l.organization });
    if (store?.connected) {
      const { gql } = require("./shopify/client");
      await gql(
        store,
        `mutation($i: ProductDeleteInput!) { productDelete(input: $i) { deletedProductId userErrors { message } } }`,
        { i: { id: l.shopifyId } },
      ).catch(() => {});
      l.shopifyId = "";
    }
  }
  l.status = "rejected";
  l.reason = reason || "";
  l.reviewedBy = user?._id;
  l.reviewedByName = user?.name || "";
  l.reviewedAt = new Date();
  await l.save();
}

// What the seller sees of a listing.
const sellerView = (l) => ({
  _id: l._id,
  title: l.title,
  brand: l.brand,
  handle: l.handle,
  status: l.status,
  error: l.status === "failed" ? l.error : "",
  reason: l.reason || "",
  image: l.images?.[0]?.src || "",
  fileName: l.fileName,
  createdAt: l.createdAt,
  reviewedAt: l.reviewedAt,
  variants: (l.variants || []).map((v) => ({
    sku: v.sku,
    options: v.options,
    price: v.price,
    cost: v.cost,
    qty: v.qty,
    finalPrice: l.status === "approved" ? v.finalPrice : undefined,
  })),
  url:
    l.status === "approved" && l.shopifyHandle
      ? `/products/${l.shopifyHandle}`
      : "",
});

module.exports = {
  COLUMNS,
  HEADERS,
  sampleXlsx,
  readRows,
  buildProducts,
  check,
  submit,
  processQueue,
  createDraft,
  approve,
  reject,
  sellerView,
  takenSkus,
};
