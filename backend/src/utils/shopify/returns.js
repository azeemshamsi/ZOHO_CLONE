/**
 * Returns: "return created" (customer return opened) and "return closed" (parcel back in the warehouse,
 * scanned by AWB or order number). Both are mirrored in Shopify when the order was fulfilled there.
 * Closing a return on an invoiced order makes a credit note. The returned stock comes back into OrdexaGo
 * only when inventory sync to Shopify is on and the item's own Shopify sync is on; otherwise the credit
 * note carries the amount but no stock. Returns never restock Shopify directly: with sync on, Shopify
 * simply gets OrdexaGo's new quantity. An order that was never invoiced just stops reserving stock.
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
  if (order.channel !== "amazon" && store?.connected)
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

async function creditNoteFor(ctx, order, store) {
  const inv = await Invoice.findById(order.invoice).lean();
  if (!inv || ["void", "draft"].includes(inv.status)) return null;
  // Items whose stock comes back: store-wide inventory sync on and the item's own Shopify sync on.
  const Item = require("../../models/Item");
  const ids = inv.lineItems.filter((l) => l.item).map((l) => l.item);
  const restock = new Set(
    store?.inventorySync && ids.length ? (await Item.find({ _id: { $in: ids }, shopifySync: true }, { _id: 1 }).lean()).map((i) => String(i._id)) : []
  );
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
    ...(inv.ledger ? { ledger: String(inv.ledger) } : {}),
    lineItems: inv.lineItems.map((l) => ({ item: l.item && restock.has(String(l.item)) ? String(l.item) : null, name: l.name, description: l.description || "", hsnSac: l.hsnSac || "", unit: l.unit || "", quantity: l.quantity, rate: l.rate, discount: l.discount || 0, taxRate: l.taxRate || 0 })),
    customerNotes: `Return of ${order.channel === "amazon" ? "Amazon" : "Shopify"} order ${order.name}${order.shipment?.awb ? ` (AWB ${order.shipment.awb})` : ""}`,
  });
  return cn;
}

// The part that talks to Shopify and makes the credit note (slow: several network calls).
async function finishReturn(ctx, order, store, was) {
  const out = { warning: "" };
  if (order.channel !== "amazon" && store?.connected && was !== "ready_to_ship")
    try {
      const id = order.shopifyReturnId || (await createInShopify(store, order, was === "rto" ? "RTO — returned by courier" : "Returned"));
      order.shopifyReturnId = id;
      await closeInShopify(store, id);
    } catch (e) {
      out.warning = `Closed in OrdexaGo; Shopify: ${e.message}`;
    }
  if (order.invoice && store?.returnCreditNote !== false && !order.returnCreditNote) {
    try {
      const cn = await creditNoteFor({ ...ctx, org: order.invoiceOrg || ctx.org }, order, store);
      if (cn) {
        order.returnCreditNote = cn._id;
        out.creditNote = cn.number;
        if (!cn.lineItems?.some((l) => l.item)) out.warning = [out.warning, "No stock put back (inventory sync or the item's Shopify sync is off)"].filter(Boolean).join(" · ");
      }
    } catch (e) {
      out.error = `Credit note not made: ${e.message}`;
    }
  }
  return out;
}

/**
 * Close a return. With { background: true } the order is marked returned straight away and the
 * Shopify return + credit note are finished afterwards (result saved in order.returnSync).
 */
async function markReturnClosed(ctx, order, store, { background = false } = {}) {
  const retry = order.status === "returned" && order.returnSync?.state === "error";
  if (order.status === "returned" && !retry) return { already: true };
  if (!retry && !["shipped", "delivered", "rto", "return_created", "ready_to_ship"].includes(order.status)) throw new Error(`Order is ${order.status.replace(/_/g, " ")}, not out for delivery or returned`);
  const was = retry ? order.returnSync?.was || "returned" : order.status;
  order.status = "returned";
  if (!retry) order.returnedAt = new Date();
  order.statusChangedAt = new Date();
  const run = async () => {
    const r = await finishReturn(ctx, order, store, was);
    order.returnSync = { state: r.error ? "error" : "done", message: [r.warning, r.error].filter(Boolean).join(" · "), creditNoteNumber: r.creditNote || order.returnSync?.creditNoteNumber || "", at: new Date(), was };
    order.markModified("returnSync");
    await order.save();
    return r;
  };
  if (background) {
    order.returnSync = { state: "pending", message: "", at: new Date(), was };
    order.markModified("returnSync");
    await order.save();
    setImmediate(() => run().catch(async (e) => {
      console.error(`Return ${order.name} sync failed:`, e.message);
      await ShopifyOrder.updateOne({ _id: order._id }, { returnSync: { state: "error", message: e.message, at: new Date(), was } }).catch(() => {});
    }));
    return { was, pending: true };
  }
  const r = await run();
  if (r.error) throw new Error(r.error);
  return { ...r, was };
}

// Find an order from scanned AWB / order numbers, in one query (a label can hold several barcodes).
async function findByCode(org, codes) {
  const list = (Array.isArray(codes) ? codes : [codes]).map((c) => String(c || "").trim()).filter(Boolean).slice(0, 10);
  if (!list.length) return null;
  const awbs = new Set();
  const names = new Set();
  const nums = new Set();
  for (const c of list) {
    const bare = c.replace(/^#/, "");
    [c, bare, bare.toUpperCase(), bare.toLowerCase()].forEach((x) => awbs.add(x));
    [`#${bare}`, bare].forEach((x) => names.add(x));
    if (/^\d{1,12}$/.test(bare)) nums.add(Number(bare));
  }
  const found = await ShopifyOrder.find({
    organization: org,
    $or: [{ "shipment.awb": { $in: [...awbs] } }, { name: { $in: [...names] } }, ...(nums.size ? [{ orderNumber: { $in: [...nums] } }] : [])],
  }).limit(10);
  if (!found.length) return null;
  // Prefer an AWB match (in the order the codes were given), then an order number.
  for (const c of list) {
    const bare = c.replace(/^#/, "").toUpperCase();
    const byAwb = found.find((o) => String(o.shipment?.awb || "").toUpperCase() === bare);
    if (byAwb) return byAwb;
  }
  return found[0];
}

module.exports = { markReturnCreated, markReturnClosed, findByCode };
