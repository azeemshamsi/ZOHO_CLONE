/**
 * Marketplace sellers: which seller each Shopify order line belongs to (by the product's Vendor), pickup from the
 * seller's address when booking, their Shopify stock, and the monthly purchase orders for delivered orders.
 */
const crypto = require("crypto");
const Seller = require("../models/Seller");

const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const r4 = (n) => Math.round((Number(n) + Number.EPSILON) * 10000) / 10000;
const norm = (s) => String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
const IST = 5.5 * 3600000;

/* ---------------- brand → seller ---------------- */
const cache = new Map(); // org → { at, map }
async function brandMap(org) {
  const k = String(org);
  const hit = cache.get(k);
  if (hit && Date.now() - hit.at < 30000) return hit.map;
  const map = new Map();
  for (const s of await Seller.find({ organization: org, active: true }).lean()) for (const b of s.brands || []) if (norm(b)) map.set(norm(b), s);
  cache.set(k, { at: Date.now(), map });
  return map;
}
const clearCache = () => cache.clear();
const sellerOfLine = (map, line) => map.get(norm(line.vendor)) || null;

async function sellersOfLines(org, lines) {
  if (!org) return [];
  const map = await brandMap(org);
  if (!map.size) return [];
  const ids = new Map();
  for (const l of lines) {
    const s = sellerOfLine(map, l);
    if (s) ids.set(String(s._id), s._id);
  }
  return [...ids.values()];
}

// Re-tag every order of the store after a seller's brands change.
async function assignAll(org) {
  clearCache();
  const ShopifyOrder = require("../models/ShopifyOrder");
  const map = await brandMap(org);
  let changed = 0;
  for (const o of await ShopifyOrder.find({ organization: org }, { "lines.vendor": 1, sellers: 1 }).lean()) {
    const ids = [...new Map(o.lines.map((l) => sellerOfLine(map, l)).filter(Boolean).map((s) => [String(s._id), s._id])).values()];
    if (ids.map(String).sort().join() !== (o.sellers || []).map(String).sort().join()) {
      await ShopifyOrder.updateOne({ _id: o._id }, { $set: { sellers: ids } });
      changed++;
    }
  }
  require("./shopify/orderIndex").forget(org);
  return changed;
}

/* ---------------- pickup when booking ---------------- */
// Where an order is picked up from: the seller's address when all its products are one seller's.
// choice: "" (automatic) | "own" | "seller:<id>".
async function pickupFor(storeOrg, order, choice = "") {
  const map = await brandMap(storeOrg);
  const groups = new Map(); // key → seller | null
  for (const l of order.lines.filter((x) => x.quantity > 0)) {
    const s = sellerOfLine(map, l);
    groups.set(s ? String(s._id) : "own", s);
  }
  if (choice === "own") return null;
  if (choice && choice.startsWith("seller:")) {
    const s = await Seller.findOne({ _id: choice.slice(7), organization: storeOrg });
    if (!s) throw new Error("That seller wasn't found");
    return s;
  }
  if (groups.size > 1) {
    const names = [...groups.values()].map((s) => (s ? s.name : "your own stock"));
    throw new Error(`${order.name} has products from ${names.join(" and ")}, which ship from different places. Book it on its own and choose where it's picked up from.`);
  }
  const only = [...groups.values()][0];
  return only ? await Seller.findById(only._id) : null;
}

// The courier account as seen for one seller's shipment: pickup address and pickup codes replaced.
// A Proxy, so token refreshes saved by the carrier code still save the real account unchanged.
function withPickup(acc, seller) {
  if (!seller) return acc;
  const p = seller.pickup || {};
  const c = (seller.couriers || {})[String(acc._id)] || {};
  const pickup = { name: p.name || seller.name, phone: p.phone || seller.phone, address: p.address, city: p.city, state: p.state, pincode: p.pincode };
  const base = acc.options && typeof acc.options.toObject === "function" ? acc.options.toObject() : { ...(acc.options || {}) };
  const options = { ...base };
  if (["shiprocket", "delhivery"].includes(acc.carrier)) options.pickupLocation = c.pickupLocation || "";
  if (acc.carrier === "bluedart") for (const k of ["originArea", "customerCode", "vendorCode"]) if (c[k]) options[k] = c[k];
  return new Proxy(acc, {
    get: (t, k) => (k === "pickup" ? pickup : k === "options" ? options : k === "_sellerView" ? true : Reflect.get(t, k, t)),
    set: (t, k, v) => {
      t[k] = v;
      return true;
    },
  });
}

function pickupProblems(seller) {
  const p = seller.pickup || {};
  const miss = [];
  if (!p.address || p.address.length < 10) miss.push("address");
  if (!/^\d{6}$/.test(p.pincode || "")) miss.push("6-digit pincode");
  if (String(p.phone || seller.phone || "").replace(/\D/g, "").length < 10) miss.push("phone");
  if (!p.city) miss.push("city");
  if (!p.state) miss.push("state");
  return miss;
}

// Register the seller's pickup address with a courier that keeps pickup locations (Delhivery warehouses,
// Shiprocket pickup addresses). Others take the address with every booking.
async function registerPickup(seller, acc) {
  const { CARRIERS } = require("./couriers");
  const { request, short } = require("./couriers/http");
  const { STATES } = require("./states");
  const stateName = (code) => STATES.find(([c]) => c === code)?.[1] || code || "";
  const miss = pickupProblems(seller);
  if (miss.length) throw new Error(`Fill in ${seller.name}'s pickup ${miss.join(", ")} first`);
  const p = seller.pickup;
  const phone = String(p.phone || seller.phone).replace(/\D/g, "").slice(-10);
  const key = String(acc._id);
  const prev = (seller.couriers || {})[key] || {};
  let out;
  if (acc.carrier === "delhivery") {
    const name = (prev.pickupLocation || `${seller.name} ${p.pincode}`).slice(0, 50);
    const body = { name, registered_name: seller.name, email: seller.email || "", phone, address: p.address, city: p.city, pin: p.pincode, country: "India", return_address: p.address, return_pin: p.pincode, return_city: p.city, return_state: stateName(p.state), return_country: "India" };
    const base = CARRIERS.delhivery.base(acc);
    const { status, data } = await request(`${base}/api/backend/clientwarehouse/create/`, { method: "POST", headers: CARRIERS.delhivery.h(acc), json: body });
    const text = JSON.stringify(data || {});
    if (status >= 400 && !/already exist/i.test(text)) throw new Error(`Delhivery didn't create the warehouse (${status}): ${data?.error || data?.message || short(data)}`);
    if (data && data.success === false && !/already exist/i.test(text)) throw new Error(`Delhivery: ${data.error || data.message || short(data)}`);
    out = { pickupLocation: data?.data?.name || name, status: "registered" };
  } else if (acc.carrier === "shiprocket") {
    const nick = (prev.pickupLocation || seller.name.replace(/[^A-Za-z0-9 ]/g, "").trim()).slice(0, 36) || `Seller-${String(seller._id).slice(-6)}`;
    const { status, data } = await CARRIERS.shiprocket.call(acc, "/settings/company/addpickup", { method: "POST", json: { pickup_location: nick, name: p.name || seller.name, email: seller.email || "", phone, address: p.address, address_2: "", city: p.city, state: stateName(p.state), country: "India", pin_code: p.pincode } });
    const text = JSON.stringify(data || {});
    if ((status >= 400 || data?.success === false) && !/already|exist/i.test(text)) throw new Error(`Shiprocket didn't add the pickup address (${status}): ${data?.message || short(data)}${data?.errors ? ` ${JSON.stringify(data.errors)}` : ""}`);
    out = { pickupLocation: nick, status: /already|exist/i.test(text) && status >= 400 ? "exists" : "registered", note: "Shiprocket may ask to verify a new pickup address by OTP on the seller's phone" };
  } else {
    out = { status: "per_booking", note: acc.carrier === "bluedart" ? "Blue Dart takes the address with each waybill. If Blue Dart gave this location its own area / customer code, enter it." : "The address is sent with each booking." };
  }
  const couriers = { ...(seller.couriers || {}), [key]: { ...prev, ...out, error: "", at: new Date() } };
  await Seller.updateOne({ _id: seller._id }, { $set: { couriers } });
  seller.couriers = couriers;
  return couriers[key];
}

/* ---------------- seller's products and stock on Shopify ---------------- */
async function locationOf(store) {
  if (store.locationId) return store.locationId;
  const locs = await require("./shopify/inventory").locations(store);
  if (!locs.length) throw new Error("The Shopify store has no active location");
  return locs[0].id;
}
const brandQuery = (seller) => seller.brands.map((b) => `vendor:"${String(b).replace(/"/g, '\\"')}"`).join(" OR ");

async function sellerProducts(store, seller, { after, q } = {}) {
  const { gql } = require("./shopify/client");
  if (!seller.brands?.length) return { products: [], next: null };
  const loc = await locationOf(store);
  const words = String(q || "").trim().replace(/["\\]/g, "");
  const query = `(${brandQuery(seller)})${words ? ` AND (title:*${words}* OR sku:${words}*)` : ""}`;
  const d = await gql(
    store,
    `query($q: String, $after: String, $loc: ID!) { products(first: 25, after: $after, query: $q, sortKey: TITLE) { pageInfo { hasNextPage endCursor } nodes { id title vendor status featuredImage { url } variants(first: 50) { nodes { id title sku price image { url } inventoryItem { id tracked inventoryLevel(locationId: $loc) { quantities(names: ["available"]) { name quantity } } } } } } } }`,
    { q: query, after: after || null, loc }
  );
  const brands = new Set(seller.brands.map(norm));
  const products = (d.products?.nodes || [])
    .filter((p) => brands.has(norm(p.vendor)))
    .map((p) => ({
      id: p.id,
      title: p.title,
      vendor: p.vendor,
      status: p.status,
      image: p.featuredImage?.url || "",
      variants: (p.variants?.nodes || []).map((v) => ({ id: v.id, title: v.title === "Default Title" ? "" : v.title, sku: v.sku || "", price: Number(v.price) || 0, image: v.image?.url || "", tracked: v.inventoryItem?.tracked !== false, available: v.inventoryItem?.inventoryLevel?.quantities?.[0]?.quantity ?? null })),
    }));
  return { products, next: d.products?.pageInfo?.hasNextPage ? d.products.pageInfo.endCursor : null };
}

// Set the available quantity of one of the seller's variants at the store's location.
async function setSellerStock(store, seller, variantId, quantity) {
  const { gql } = require("./shopify/client");
  const loc = await locationOf(store);
  const d = await gql(store, `query($id: ID!) { productVariant(id: $id) { id sku product { vendor title } inventoryItem { id tracked } } }`, { id: variantId });
  const v = d.productVariant;
  if (!v || !seller.brands.map(norm).includes(norm(v.product?.vendor))) throw new Error("That product isn't one of yours");
  const inv = v.inventoryItem.id;
  if (v.inventoryItem.tracked === false) await gql(store, `mutation($id: ID!) { inventoryItemUpdate(id: $id, input: { tracked: true }) { userErrors { message } } }`, { id: inv });
  const set = () =>
    gql(store, `mutation($input: InventorySetQuantitiesInput!) { inventorySetQuantities(input: $input) @idempotent(key: "${crypto.randomUUID()}") { userErrors { code message } } }`, {
      input: { name: "available", reason: "correction", referenceDocumentUri: `ordexago://seller/${seller._id}`, quantities: [{ inventoryItemId: inv, locationId: loc, quantity, changeFromQuantity: null }] },
    });
  let r = await set();
  let errs = r.inventorySetQuantities?.userErrors || [];
  if (errs.some((e) => /not stocked|NOT_STOCKED|inactive/i.test(`${e.code} ${e.message}`))) {
    await gql(store, `mutation($i: ID!, $l: ID!) { inventoryActivate(inventoryItemId: $i, locationId: $l) { userErrors { message } } }`, { i: inv, l: loc });
    r = await set();
    errs = r.inventorySetQuantities?.userErrors || [];
  }
  if (errs.length) throw new Error(errs.map((e) => e.message).join("; "));
  return { variantId, sku: v.sku, quantity };
}

/* ---------------- monthly purchase orders ---------------- */
// Month "2026-10" → its first and last instant in India.
function monthRange(month) {
  const [y, m] = month.split("-").map(Number);
  return { from: new Date(Date.UTC(y, m - 1, 1) - IST), to: new Date(Date.UTC(y, m, 1) - IST - 1), label: new Date(Date.UTC(y, m - 1, 15)).toLocaleDateString("en-IN", { month: "long", year: "numeric" }) };
}
const prevMonth = (d = new Date()) => {
  const t = new Date(d.getTime() + IST);
  const y = t.getUTCMonth() === 0 ? t.getUTCFullYear() - 1 : t.getUTCFullYear();
  const m = t.getUTCMonth() === 0 ? 12 : t.getUTCMonth();
  return `${y}-${String(m).padStart(2, "0")}`;
};
const deliveredOn = (o) => o.deliveredAt || o.statusChangedAt || null;

// What we owe a seller for one order line: rate% of the sale price incl. GST, before our discounts.
const lineValue = (l) => r2((l.unitPrice || 0) * (l.quantity || 0));
const linePurchase = (seller, l) => r2((lineValue(l) * seller.rate) / 100);

// The seller's vendor record in a company (created the first time).
async function vendorIn(seller, orgId) {
  const Vendor = require("../models/Vendor");
  const id = (seller.vendors || {})[String(orgId)];
  let v = id ? await Vendor.findOne({ _id: id, organization: orgId }) : null;
  if (!v && seller.gstin) v = await Vendor.findOne({ organization: orgId, gstin: seller.gstin });
  if (!v) v = await Vendor.findOne({ organization: orgId, displayName: seller.name });
  const state = seller.gstin ? seller.gstin.slice(0, 2) : seller.pickup?.state || "";
  if (!v) {
    const p = seller.pickup || {};
    v = await Vendor.create({
      organization: orgId,
      displayName: seller.name,
      companyName: seller.name,
      email: seller.email || "",
      phone: seller.phone || "",
      gstin: seller.gstin || "",
      pan: seller.pan || "",
      gstTreatment: seller.gstin ? "registered" : "unregistered",
      placeOfSupply: state,
      billingAddress: { street: p.address || "", city: p.city || "", state: p.state || state, pincode: p.pincode || "", country: "India" },
      notes: "Marketplace seller (Store → Sellers)",
    });
  }
  if (String((seller.vendors || {})[String(orgId)] || "") !== String(v._id)) {
    seller.vendors = { ...(seller.vendors || {}), [String(orgId)]: String(v._id) };
    await Seller.updateOne({ _id: seller._id }, { $set: { vendors: seller.vendors } });
  }
  return v;
}

/**
 * Purchase orders for one month: per seller and company, the lines of orders delivered that month and not yet on a
 * PO, at the seller's rate; pending deductions up to the month end are taken off. Safe to run again (skips what's done).
 * An order counts once it has been delivered at least HOLD_DAYS ago and is still delivered (no return / RTO since).
 * Orders delivered earlier but not settled yet (e.g. delivered on the 30th, so not 7 days old at the last run) are
 * included too, so nothing is left out.
 */
const HOLD_DAYS = 7;
async function runMonthly(storeOrg, month, user, { sellerId, dryRun = false, createdBefore } = {}) {
  const ShopifyOrder = require("../models/ShopifyOrder");
  const SellerPenalty = require("../models/SellerPenalty");
  const Organization = require("../models/Organization");
  const Item = require("../models/Item");
  const { call } = require("./import/commit");
  const { computeTotals } = require("./gst");
  const { to, label } = monthRange(month);
  const ripe = new Date(Date.now() - HOLD_DAYS * 86400000); // delivered on or before this
  const sellers = (await Seller.find({ organization: storeOrg, ...(sellerId ? { _id: sellerId } : { active: true }) })).filter((x) => !createdBefore || x.createdAt < createdBefore);
  const results = [];
  for (const seller of sellers) {
    const unsettled = (await ShopifyOrder.find({ organization: storeOrg, sellers: seller._id, status: "delivered" }).lean()).filter((o) => {
      const d = deliveredOn(o);
      return d && d <= to && (!seller.poFrom || d >= seller.poFrom) && !(o.sellerSettled || []).some((x) => String(x.seller) === String(seller._id));
    });
    const orders = unsettled.filter((o) => deliveredOn(o) <= ripe);
    const waiting = unsettled.length - orders.length; // delivered less than 7 days ago: next month's PO
    const brands = new Set(seller.brands.map(norm));
    // Group by the company that invoiced the order (that company bought from the seller).
    const byOrg = new Map();
    for (const o of orders) {
      const lines = o.lines.filter((l) => l.quantity > 0 && brands.has(norm(l.vendor)));
      if (!lines.length) continue;
      const k = String(o.invoiceOrg || storeOrg);
      if (!byOrg.has(k)) byOrg.set(k, []);
      byOrg.get(k).push({ o, lines });
    }
    const penalties = (await SellerPenalty.find({ organization: storeOrg, seller: seller._id, date: { $lte: to } }).sort({ date: 1 }).lean()).filter((p) => !p.purchaseOrder);
    if (!byOrg.size) {
      results.push({ seller: seller.name, sellerId: seller._id, skipped: `No orders delivered by the end of ${label} and ${HOLD_DAYS}+ days ago${waiting ? ` (${waiting} delivered less than ${HOLD_DAYS} days ago wait for the next PO)` : ""}${penalties.length ? `; ${penalties.length} deduction${penalties.length > 1 ? "s" : ""} carried forward` : ""}`, waiting });
      continue;
    }
    let penaltiesLeft = penalties;
    for (const [orgId, rows] of byOrg) {
      try {
        const org = await Organization.findById(orgId);
        const itemIds = rows.flatMap((r) => r.lines.map((l) => l.item)).filter(Boolean);
        const items = new Map((await Item.find({ _id: { $in: itemIds } }, { taxRate: 1, hsnSac: 1 }).lean()).map((i) => [String(i._id), i]));
        let target = 0;
        const lineItems = [];
        const perOrder = [];
        for (const { o, lines } of rows) {
          let amt = 0;
          for (const l of lines) {
            const it = items.get(String(l.item));
            const gst = seller.gstin ? Number(it?.taxRate ?? l.shopifyTaxRate ?? 0) : 0;
            const unit = r4((l.unitPrice * seller.rate) / 100);
            const value = linePurchase(seller, l);
            amt = r2(amt + value);
            lineItems.push({
              name: `${o.name} · ${l.title}${l.variantTitle ? ` - ${l.variantTitle}` : ""}`.slice(0, 200),
              description: `${l.sku ? `SKU ${l.sku} · ` : ""}delivered ${new Date(deliveredOn(o).getTime() + IST).toISOString().slice(0, 10)} · ${seller.rate}% of ₹${lineValue(l)}`,
              hsnSac: it?.hsnSac || l.hsn || "",
              unit: "pcs",
              quantity: l.quantity,
              rate: r4(unit / (1 + gst / 100)),
              discount: 0,
              taxRate: gst,
            });
          }
          target = r2(target + amt);
          perOrder.push({
            id: o._id,
            amount: amt,
            name: o.name,
            deliveredAt: deliveredOn(o),
            sale: r2(lines.reduce((t, l) => t + lineValue(l), 0)),
            items: lines.map((l) => ({ title: `${l.title}${l.variantTitle ? ` - ${l.variantTitle}` : ""}`, sku: l.sku || "", quantity: l.quantity, sale: lineValue(l), purchase: linePurchase(seller, l) })),
          });
        }
        // Deductions: those for this company's orders, then any others, while the PO stays above zero.
        const mine = penaltiesLeft.filter((p) => !p.order || rows.some((r) => String(r.o._id) === String(p.order)) || byOrg.size === 1);
        const applied = [];
        let pen = 0;
        for (const p of mine) {
          if (pen + p.amount > target) continue;
          pen = r2(pen + p.amount);
          applied.push(p);
        }
        penaltiesLeft = penaltiesLeft.filter((p) => !applied.includes(p));
        if (dryRun) {
          results.push({
            seller: seller.name,
            sellerId: seller._id,
            rate: seller.rate,
            company: org.name,
            organization: orgId,
            orders: perOrder.length,
            lines: lineItems.length,
            amount: target,
            penalties: pen,
            total: r2(target - pen),
            waiting,
            // The orders and deductions that would go on this PO.
            orderList: [...perOrder].sort((a, b) => a.deliveredAt - b.deliveredAt),
            deductionList: applied.map((p) => ({ id: p._id, amount: p.amount, reason: p.reason || p.note || "", order: p.orderName || "" })),
          });
          continue;
        }
        const vendor = await vendorIn(seller, orgId);
        const t = computeTotals({ lineItems, orgState: org.state, placeOfSupply: vendor.placeOfSupply || org.state });
        // −deductions (+ rounding paise, so the PO equals the rate exactly). No ledger of its own: on the bill it reduces the
        // purchase ledger ("ledger"), since the seller's invoice is already net of it.
        const adjustment = r2(target - pen - t.total);
        const iso = new Date(Date.now() + IST).toISOString().slice(0, 10);
        const po = await call(require("../routes/purchaseOrders"), "POST", "/", { org: orgId, user }, {
          vendor: String(vendor._id),
          date: iso,
          reference: `${seller.name} · ${label}`.slice(0, 100),
          lineItems,
          adjustment,
          ...(adjustment ? { adjustmentAccount: "ledger" } : {}),
          customerNotes: `Orders delivered up to ${label} (at least ${HOLD_DAYS} days before this PO, not returned), at ${seller.rate}% of the sale price (GST included, before discounts).${applied.length ? `\nDeductions: ${applied.map((p) => `${p.reason}${p.orderName ? ` (${p.orderName})` : ""} ₹${p.amount}`).join("; ")}.` : ""}\nPlease send your invoice against this purchase order.`,
          status: "issued",
        });
        for (const r of perOrder) await ShopifyOrder.updateOne({ _id: r.id }, { $push: { sellerSettled: { seller: seller._id, purchaseOrder: po._id, number: po.number, organization: orgId, amount: r.amount, at: new Date() } } });
        for (const p of applied) await SellerPenalty.updateOne({ _id: p._id }, { $set: { purchaseOrder: po._id, purchaseOrderNumber: po.number, purchaseOrderOrg: orgId } });
        results.push({ seller: seller.name, sellerId: seller._id, company: org.name, purchaseOrder: po.number, purchaseOrderId: po._id, organization: orgId, orders: perOrder.length, amount: target, penalties: pen, total: po.total, waiting });
      } catch (e) {
        results.push({ seller: seller.name, sellerId: seller._id, error: e.message });
      }
    }
  }
  return results;
}

// Called hourly: on/after the 8th (so an order delivered on the 31st has had its 7 days), make last month's
// purchase orders once per store.
const RUN_DAY = 8;
async function monthlyTick() {
  const now = new Date(Date.now() + IST);
  if (now.getUTCDate() < RUN_DAY) return;
  const mongoose = require("mongoose");
  const runs = mongoose.connection.db.collection("seller_po_runs");
  const month = prevMonth();
  const orgs = await Seller.distinct("organization", { active: true });
  for (const org of orgs) {
    const id = `${org}:${month}`;
    if (await runs.findOne({ _id: id })) continue;
    await runs.insertOne({ _id: id, startedAt: new Date() });
    try {
      const Membership = require("../models/Membership");
      const m = await Membership.findOne({ organization: org, role: "admin", status: "active" }).sort({ createdAt: 1 }).populate("user");
      // Only sellers that were set up before this month's run day: one added later is run by hand (Store → Sellers).
      const cutoff = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), RUN_DAY) - IST);
      const results = await runMonthly(org, month, m?.user, { createdBefore: cutoff });
      await runs.updateOne({ _id: id }, { $set: { at: new Date(), results } });
      console.log(`Seller purchase orders ${month} (org ${org}): ${results.filter((r) => r.purchaseOrder).length} created`);
    } catch (e) {
      await runs.updateOne({ _id: id }, { $set: { error: e.message } });
      console.error(`Seller purchase orders ${month} failed: ${e.message}`);
    }
  }
}

// Orders that will go on this seller's next purchase orders (delivered on/after poFrom, by the end of `month`, not on
// a PO or excluded). ready: delivered at least HOLD_DAYS ago (else it waits for the next run).
async function pendingOrders(seller, month) {
  const ShopifyOrder = require("../models/ShopifyOrder");
  const { to } = monthRange(month);
  const ripe = new Date(Date.now() - HOLD_DAYS * 86400000);
  const brands = new Set(seller.brands.map(norm));
  return (await ShopifyOrder.find({ organization: seller.organization, sellers: seller._id, status: "delivered" }).lean())
    .filter((o) => {
      const d = deliveredOn(o);
      return d && d <= to && (!seller.poFrom || d >= seller.poFrom) && !(o.sellerSettled || []).some((x) => String(x.seller) === String(seller._id));
    })
    .map((o) => {
      const lines = o.lines.filter((l) => l.quantity > 0 && brands.has(norm(l.vendor)));
      return { _id: o._id, name: o.name, orderDate: o.orderDate, deliveredAt: deliveredOn(o), ready: deliveredOn(o) <= ripe, items: lines.map((l) => `${l.quantity} × ${l.title}${l.sku ? ` (${l.sku})` : ""}`), value: r2(lines.reduce((t, l) => t + lineValue(l), 0)), amount: r2(lines.reduce((t, l) => t + linePurchase(seller, l), 0)) };
    })
    .sort((a, b) => new Date(a.deliveredAt) - new Date(b.deliveredAt));
}

module.exports = { pendingOrders, HOLD_DAYS, norm, brandMap, clearCache, sellerOfLine, sellersOfLines, assignAll, pickupFor, withPickup, pickupProblems, registerPickup, sellerProducts, setSellerStock, runMonthly, monthlyTick, monthRange, prevMonth, linePurchase, lineValue, deliveredOn };
