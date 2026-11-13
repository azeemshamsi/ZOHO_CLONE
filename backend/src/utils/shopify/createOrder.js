/**
 * Orders taken in OrdexaGo (phone, WhatsApp, Instagram…) created in Shopify, so the store's order numbers,
 * stock, customer accounts and notifications stay in one place; the new order then comes back into Store → Orders.
 *
 * Shopify: draftOrderCreate → then
 *   cod  : draftOrderComplete(paymentPending) — order created, payment pending (shows as COD here)
 *   paid : draftOrderComplete — order created and marked paid (money already received: UPI, bank transfer)
 *   link : the draft stays open; its checkout link goes to the customer, and the order is created when they pay.
 * Needs the read_draft_orders / write_draft_orders scopes.
 */
const { gql } = require("./client");
const { ORDERS_QUERY, normalise, upsert } = require("./sync");
const { stateCode } = require("../import/common");

// GST state code → Shopify's province code for India (as Shopify lists them).
const PROVINCE = {
  35: "AN",
  37: "AP",
  12: "AR",
  18: "AS",
  10: "BR",
  "04": "CH",
  22: "CG",
  26: "DN",
  "07": "DL",
  30: "GA",
  24: "GJ",
  "06": "HR",
  "02": "HP",
  "01": "JK",
  20: "JH",
  29: "KA",
  32: "KL",
  38: "LA",
  31: "LD",
  23: "MP",
  27: "MH",
  14: "MN",
  17: "ML",
  15: "MZ",
  13: "NL",
  21: "OR",
  34: "PY",
  "03": "PB",
  "08": "RJ",
  11: "SK",
  33: "TN",
  36: "TS",
  16: "TR",
  "09": "UP",
  "05": "UK",
  19: "WB",
};
const provinceOf = (state) =>
  PROVINCE[stateCode(state)] || PROVINCE[Number(stateCode(state))] || "";
const phoneOf = (p) => {
  const d = String(p || "").replace(/\D/g, "");
  if (d.length === 10) return `+91${d}`;
  if (d.length === 12 && d.startsWith("91")) return `+${d}`;
  if (d.length === 11 && d.startsWith("0")) return `+91${d.slice(1)}`;
  return d ? `+${d}` : "";
};
const money = (n) => ({
  amount: String(Math.round(Number(n) * 100) / 100),
  currencyCode: "INR",
});

const MEDIA = "preview { image { url(transform: { maxWidth: 120 }) } }";

async function searchProducts(store, q) {
  const s = String(q || "")
    .replace(/["\\]/g, "")
    .trim();
  const query = s
    ? `product_status:active AND (sku:${s}* OR title:*${s}* OR ${s})`
    : "product_status:active";
  const d = await gql(
    store,
    `query($q: String) { productVariants(first: 25, query: $q) { nodes { id title displayName sku price inventoryQuantity
      media(first: 1) { nodes { ${MEDIA} } } product { title featuredMedia { ${MEDIA} } } } } }`,
    { q: query },
  );
  return (d.productVariants?.nodes || []).map((v) => ({
    variantId: v.id,
    title: v.product?.title || v.displayName,
    variant: v.title && v.title !== "Default Title" ? v.title : "",
    sku: v.sku || "",
    price: Number(v.price) || 0,
    stock: v.inventoryQuantity,
    image:
      v.media?.nodes?.[0]?.preview?.image?.url ||
      v.product?.featuredMedia?.preview?.image?.url ||
      "",
  }));
}

async function searchCustomers(store, q) {
  const s = String(q || "")
    .replace(/["\\]/g, "")
    .trim();
  if (s.length < 2) return [];
  const digits = s.replace(/\D/g, "");
  const query =
    digits.length >= 6 && digits.length === s.replace(/[\s+-]/g, "").length
      ? `phone:*${digits.slice(-10)}`
      : s;
  const d = await gql(
    store,
    `query($q: String) { customers(first: 10, query: $q) { nodes { id displayName numberOfOrders defaultEmailAddress { emailAddress } defaultPhoneNumber { phoneNumber }
      defaultAddress { firstName lastName company address1 address2 city province provinceCode zip phone } } } }`,
    { q: query },
  );
  return (d.customers?.nodes || []).map((c) => {
    const a = c.defaultAddress || {};
    return {
      id: c.id,
      name: c.displayName || "",
      email: c.defaultEmailAddress?.emailAddress || "",
      phone: c.defaultPhoneNumber?.phoneNumber || a.phone || "",
      orders: Number(c.numberOfOrders) || 0,
      address: {
        name: [a.firstName, a.lastName].filter(Boolean).join(" "),
        company: a.company || "",
        address1: a.address1 || "",
        address2: a.address2 || "",
        city: a.city || "",
        state: stateCode(a.provinceCode || a.province) || "",
        zip: a.zip || "",
        phone: a.phone || "",
      },
    };
  });
}

const userErr = (errs) =>
  (errs || [])
    .map((e) =>
      [(e.field || []).join("."), e.message].filter(Boolean).join(": "),
    )
    .join("; ");

// body: { customerId?, customer: {name, email, phone}, address: {name, company, address1, address2, city, state, zip, phone},
//         lines: [{variantId, quantity, price?}], shipping: {title, amount}, discount: {type: "percent"|"amount", value, reason},
//         payment: "cod"|"paid"|"link", note, tags: [] }
async function createOrder(store, body, { user } = {}) {
  const a = body.address || {};
  const c = body.customer || {};
  const [first, ...rest] = String(a.name || c.name || "")
    .trim()
    .split(/\s+/);
  const province = provinceOf(a.state);
  if (!province) throw new Error("Choose the state of the delivery address");
  const addr = {
    firstName: first || "",
    lastName: rest.join(" ") || ".",
    company: a.company || null,
    address1: a.address1,
    address2: a.address2 || null,
    city: a.city,
    provinceCode: province,
    zip: String(a.zip || "").replace(/\s/g, ""),
    countryCode: "IN",
    phone: phoneOf(a.phone || c.phone) || null,
  };
  const lines = (body.lines || []).filter(
    (l) => l.variantId && Number(l.quantity) > 0,
  );
  if (!lines.length) throw new Error("Add at least one product");
  const tags = [
    "OrdexaGo",
    ...(body.payment === "cod" ? ["COD"] : []),
    ...(body.tags || []),
  ]
    .map((t) => String(t).trim())
    .filter(Boolean);
  const input = {
    email: c.email || null,
    phone: phoneOf(c.phone) || null,
    shippingAddress: addr,
    billingAddress: addr,
    note: [
      body.note,
      user?.name
        ? `Created in OrdexaGo by ${user.name}`
        : "Created in OrdexaGo",
    ]
      .filter(Boolean)
      .join("\n"),
    tags: [...new Set(tags)],
    lineItems: lines.map((l) => {
      const li = {
        variantId: l.variantId,
        quantity: Math.round(Number(l.quantity)),
      };
      if (
        l.price != null &&
        l.price !== "" &&
        Number(l.basePrice) !== Number(l.price)
      )
        li.priceOverride = money(l.price);
      return li;
    }),
  };
  if (body.customerId) input.purchasingEntity = { customerId: body.customerId };
  if (
    body.shipping &&
    (Number(body.shipping.amount) > 0 || body.shipping.title)
  )
    input.shippingLine = {
      title: body.shipping.title || "Shipping",
      priceWithCurrency: money(body.shipping.amount || 0),
    };
  const dv = Number(body.discount?.value) || 0;
  if (dv > 0)
    input.appliedDiscount = {
      title: body.discount.reason || "Discount",
      description: body.discount.reason || "",
      value: dv,
      valueType:
        body.discount.type === "percent" ? "PERCENTAGE" : "FIXED_AMOUNT",
    };

  const created = await gql(
    store,
    `mutation($input: DraftOrderInput!) { draftOrderCreate(input: $input) { draftOrder { id name invoiceUrl totalPriceSet { shopMoney { amount } } } userErrors { field message } } }`,
    { input },
  );
  const err = userErr(created.draftOrderCreate?.userErrors);
  if (err) throw new Error(`Shopify: ${err}`);
  const draft = created.draftOrderCreate.draftOrder;
  const total = Number(draft.totalPriceSet?.shopMoney?.amount) || 0;

  if (body.payment === "link") {
    return {
      draft: { id: draft.id, name: draft.name, url: draft.invoiceUrl, total },
    };
  }
  const done = await gql(
    store,
    `mutation($id: ID!, $pending: Boolean) { draftOrderComplete(id: $id, paymentPending: $pending) { draftOrder { id order { id name } } userErrors { field message } } }`,
    { id: draft.id, pending: body.payment !== "paid" },
  );
  const err2 = userErr(done.draftOrderComplete?.userErrors);
  if (err2)
    throw new Error(
      `Shopify made draft ${draft.name} but couldn't complete it: ${err2}. Complete it in Shopify → Drafts.`,
    );
  const order = done.draftOrderComplete.draftOrder?.order;
  const saved = order ? await pull(store, order.id, user) : null;
  return {
    order: { shopifyId: order?.id, name: order?.name, total, id: saved?._id },
  };
}

// Bring one Shopify order into Store → Orders straight away (items made, list refreshed).
async function pull(store, shopifyId, user = null) {
  const ShopifyOrder = require("../../models/ShopifyOrder");
  const num = String(shopifyId).split("/").pop();
  const d = await gql(store, ORDERS_QUERY, {
    first: 1,
    after: null,
    query: `id:${num}`,
  });
  const o = d.orders?.nodes?.[0];
  if (!o) return null;
  await upsert(store.organization, normalise(o));
  const doc = await ShopifyOrder.findOne({
    organization: store.organization,
    shopifyId: o.id,
  });
  if (doc && user && !doc.createdBy) {
    doc.createdBy = user._id;
    doc.createdByName = user.name || "";
  }
  if (doc && !(doc.lines || []).some((l) => l.item)) {
    await require("./invoice").ensureItems(
      store.organization,
      doc,
      store,
      new Map(),
    );
  }
  if (doc) await doc.save();
  require("./orderIndex").forget(String(store.organization));
  return doc;
}

module.exports = {
  createOrder,
  searchProducts,
  searchCustomers,
  provinceOf,
  phoneOf,
  pull,
};
