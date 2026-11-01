/**
 * Returns: "return created" (customer return opened) and "return closed" (parcel back in the warehouse,
 * scanned by AWB or order number). Both are mirrored in Shopify when the order was fulfilled there.
 * Closing a return on an invoiced order makes a credit note, which puts the stock back in the books;
 * an order that was never invoiced just stops reserving stock.
 */
const ShopifyOrder = require("../../models/ShopifyOrder");
const Invoice = require("../../models/Invoice");
const { gql } = require("./client");

async function shopifyOrderInfo(store, order) {
  const d = await gql(
    store,
    `query($id: ID!) { order(id: $id) { returns(first: 5) { nodes { id status } } fulfillments(first: 10) { status fulfillmentLineItems(first: 50) { nodes { id quantity } } } } }`,
    { id: order.shopifyId }
  );
  return d.order;
}

async function reasonId(store) {
  const d = await gql(store, `{ returnReasonDefinitions(first: 100) { nodes { id handle } } }`).catch(() => null);
  const list = d?.returnReasonDefinitions?.nodes || [];
  return (list.find((r) => /^other$|unwanted|unknown|no-longer|not-needed/i.test(r.handle)) || list[0])?.id || null;
}

async function createInShopify(store, order, note) {
  const info = await shopifyOrderInfo(store, order);
  const open = (info?.returns?.nodes || []).find((r) => ["OPEN", "REQUESTED"].includes(r.status));
  if (open) return open.id;
  const lines = (info?.fulfillments || []).filter((f) => f.status !== "CANCELLED").flatMap((f) => f.fulfillmentLineItems?.nodes || []).filter((l) => l.quantity > 0);
  if (!lines.length) throw new Error("not fulfilled in Shopify, so Shopify has nothing to return");
  const make = async (rid) => {
    const r = await gql(
      store,
      `mutation($input: ReturnInput!) { returnCreate(returnInput: $input) { return { id status } userErrors { field message } } }`,
      { input: { orderId: order.shopifyId, notifyCustomer: false, returnLineItems: lines.map((l) => ({ fulfillmentLineItemId: l.id, quantity: l.quantity, returnReasonNote: (note || "Returned").slice(0, 250), ...(rid ? { returnReasonDefinitionId: rid } : {}) })) } }
    );
    return r.returnCreate;
  };
  let r = await make(null);
  if (r?.userErrors?.length && /reason/i.test(JSON.stringify(r.userErrors))) r = await make(await reasonId(store));
  if (r?.userErrors?.length) throw new Error(r.userErrors.map((e) => e.message).join("; "));
  return r.return.id;
}

async function closeInShopify(store, id) {
  const r = await gql(store, `mutation($id: ID!) { returnClose(id: $id) { return { id status } userErrors { field message } } }`, { id });
  const errs = r.returnClose?.userErrors || [];
  if (errs.length && !/closed/i.test(errs.map((e) => e.message).join(" "))) throw new Error(errs.map((e) => e.message).join("; "));
}

async function markReturnCreated(ctx, order, store, note = "") {
  if (!["shipped", "delivered", "ready_to_ship"].includes(order.status)) throw new Error(`Order is ${order.status.replace(/_/g, " ")}; only shipped or delivered orders can have a return`);
  let warning = "";
  if (store?.connected)
    try {
      order.shopifyReturnId = await createInShopify(store, order, note);
    } catch (e) {
      warning = `Not created in Shopify: ${e.message}`;
    }
  order.status = "return_created";
  order.statusChangedAt = new Date();
  if (note) order.returnNote = note;
  await order.save();
  return { warning };
}

async function creditNoteFor(ctx, order) {
  const inv = await Invoice.findById(order.invoice).lean();
  if (!inv || ["void", "draft"].includes(inv.status)) return null;
  const { call } = require("../import/commit");
  const iso = new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 10);
  const cn = await call(require("../../routes/creditNotes"), "POST", "/", ctx, {
    customer: String(inv.customer),
    invoice: String(inv._id),
    date: iso,
    status: "open",
    reason: "Sales Return",
    placeOfSupply: inv.placeOfSupply,
    ...(inv.warehouse ? { warehouse: String(inv.warehouse) } : {}),
    ...(inv.branch ? { branch: String(inv.branch) } : {}),
    adjustment: inv.adjustment || 0,
    lineItems: inv.lineItems.map((l) => ({ item: l.item ? String(l.item) : null, name: l.name, description: l.description || "", hsnSac: l.hsnSac || "", unit: l.unit || "", quantity: l.quantity, rate: l.rate, discount: l.discount || 0, taxRate: l.taxRate || 0 })),
    customerNotes: `Return of Shopify order ${order.name}${order.shipment?.awb ? ` (AWB ${order.shipment.awb})` : ""}`,
  });
  return cn;
}

async function markReturnClosed(ctx, order, store) {
  if (order.status === "returned") return { already: true };
  if (!["shipped", "delivered", "rto", "return_created", "ready_to_ship"].includes(order.status)) throw new Error(`Order is ${order.status.replace(/_/g, " ")}, not out for delivery or returned`);
  const was = order.status;
  const out = { warning: "" };
  if (store?.connected && order.status !== "ready_to_ship")
    try {
      const id = order.shopifyReturnId || (await createInShopify(store, order, was === "rto" ? "RTO — returned by courier" : "Returned"));
      order.shopifyReturnId = id;
      await closeInShopify(store, id);
    } catch (e) {
      out.warning = `Closed in MGI; Shopify: ${e.message}`;
    }
  if (order.invoice && store?.returnCreditNote !== false && !order.returnCreditNote) {
    const cn = await creditNoteFor(ctx, order);
    if (cn) {
      order.returnCreditNote = cn._id;
      out.creditNote = cn.number;
    }
  }
  order.status = "returned";
  order.returnedAt = new Date();
  order.statusChangedAt = new Date();
  await order.save();
  return { ...out, was };
}

// Find an order from a scanned AWB / order number.
async function findByCode(org, code) {
  const c = String(code || "").trim();
  if (!c) return null;
  const bare = c.replace(/^#/, "");
  return (
    (await ShopifyOrder.findOne({ organization: org, "shipment.awb": c })) ||
    (await ShopifyOrder.findOne({ organization: org, "shipment.awb": new RegExp(`^${bare.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i") })) ||
    (await ShopifyOrder.findOne({ organization: org, name: `#${bare}` })) ||
    (await ShopifyOrder.findOne({ organization: org, name: bare })) ||
    (/^\d+$/.test(bare) ? await ShopifyOrder.findOne({ organization: org, orderNumber: Number(bare) }) : null)
  );
}

module.exports = { markReturnCreated, markReturnClosed, findByCode };
