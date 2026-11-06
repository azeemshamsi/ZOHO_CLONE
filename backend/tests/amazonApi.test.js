// Amazon SP-API order processing against a mock SP-API server (no database: model calls are stubbed).
const test = require("node:test");
const assert = require("node:assert");
const http = require("http");
const zlib = require("zlib");

const B = "../src/";
const ShopifyOrder = require(B + "models/ShopifyOrder");
const ShopifyStore = require(B + "models/ShopifyStore");
const AmazonAccount = require(B + "models/AmazonAccount");
const Item = require(B + "models/Item");
const Customer = require(B + "models/Customer");
const Organization = require(B + "models/Organization");
const Account = require(B + "models/Account");

const { Types } = require("mongoose");
const oid = () => new Types.ObjectId();
const I1 = oid();
const I2 = oid();
const now = Date.now();
const iso = (d) => new Date(d).toISOString();
const money = (a) => ({ amount: String(a), currencyCode: "INR" });
const ORDERS = [
  {
    orderId: "408-1111111-1111111", createdTime: iso(now - 3600e3), lastUpdatedTime: iso(now - 600e3), programs: [], salesChannel: { marketplaceId: "A21TJRUUN4KGTV" },
    buyer: { buyerName: "Ravi Kumar", buyerEmail: "x@marketplace.amazon.in" },
    recipient: { deliveryAddress: { name: "Ravi Kumar", addressLine1: "12 MG Road", addressLine2: "Camp", city: "Pune", stateOrRegion: "MAHARASHTRA", postalCode: "411001", countryCode: "IN", phone: "9876543210" } },
    proceeds: { grandTotal: money(950) }, payment: { paymentExecutions: [{ paymentMethod: "CreditCard" }] },
    fulfillment: { fulfillmentStatus: "UNSHIPPED", fulfilledBy: "MERCHANT", shipByWindow: { latestDateTime: iso(now + 86400e3) } },
    orderItems: [{ orderItemId: "OI-1", quantityOrdered: 2, product: { asin: "B0X", title: "Mango wood board", sellerSku: "R4269", price: { unitPrice: money(500) } }, proceeds: { proceedsTotal: money(950), breakdowns: [{ type: "ITEM", subtotal: money(1000) }, { type: "SHIPPING", subtotal: money(50) }, { type: "DISCOUNT", subtotal: money(-100) }, { type: "TAX", subtotal: money(45.24) }] } }],
  },
  {
    orderId: "408-2222222-2222222", createdTime: iso(now - 7200e3), lastUpdatedTime: iso(now - 500e3), programs: ["AMAZON_EASY_SHIP", "AMAZON_BUSINESS"], salesChannel: { marketplaceId: "A21TJRUUN4KGTV" },
    buyer: { buyerName: "Asha", buyerCompanyName: "Asha Traders" },
    recipient: { deliveryAddress: { name: "Asha", addressLine1: "5 Park St", city: "Kolkata", stateOrRegion: "West Bengal", postalCode: "700016", countryCode: "IN", phone: "9830000000" } },
    proceeds: { grandTotal: money(1180) }, payment: { paymentExecutions: [{ paymentMethod: "COD" }] },
    tax: { taxRegistrations: [{ entityType: "BUYER", taxRegistrationNumber: "19AAACA1234A1Z5", legalName: "Asha Traders" }] },
    fulfillment: { fulfillmentStatus: "UNSHIPPED", fulfilledBy: "MERCHANT" },
    orderItems: [{ orderItemId: "OI-2", quantityOrdered: 1, product: { title: "Iron table", sellerSku: "FBA-AFR7342" }, proceeds: { proceedsTotal: money(1180), breakdowns: [{ type: "ITEM", subtotal: money(1180) }] } }],
  },
  { orderId: "408-3333333-3333333", createdTime: iso(now - 100e3), lastUpdatedTime: iso(now - 100e3), salesChannel: {}, fulfillment: { fulfillmentStatus: "PENDING" }, orderItems: [{ orderItemId: "OI-3", quantityOrdered: 1, product: { sellerSku: "R4269" } }] },
  {
    orderId: "408-4444444-4444444", createdTime: iso(now - 5 * 86400e3), lastUpdatedTime: iso(now - 300e3), programs: [], salesChannel: { marketplaceId: "A21TJRUUN4KGTV" },
    recipient: { deliveryAddress: { name: "Old", addressLine1: "1 St", city: "Lucknow", stateOrRegion: "Uttar Pradesh", postalCode: "226001", countryCode: "IN" } },
    proceeds: { grandTotal: money(500) }, fulfillment: { fulfillmentStatus: "SHIPPED" },
    packages: [{ packageReferenceId: "1", carrier: "Delhivery", trackingNumber: "DLV123", packageStatus: { status: "DELIVERED" } }],
    orderItems: [{ orderItemId: "OI-4", quantityOrdered: 1, product: { title: "Board", sellerSku: "R4269" }, proceeds: { proceedsTotal: money(500) } }],
  },
];

const calls = [];
let feedPolls = 0;
let rdtAllowed = true;
let base;
const pdf = Buffer.from("%PDF-1.4 fake label");
const srv = http.createServer((req, res) => {
  let b = "";
  req.on("data", (c) => (b += c));
  req.on("end", () => {
    const u = new URL(req.url, "http://x");
    calls.push({ m: req.method, p: u.pathname, q: Object.fromEntries(u.searchParams), body: b, tok: req.headers["x-amz-access-token"] });
    const send = (code, obj) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(obj === undefined ? "" : JSON.stringify(obj));
    };
    if (u.pathname === "/auth/o2/token") return b.includes("refresh_token=bad") ? send(400, { error: "invalid_grant", error_description: "The request has an invalid grant parameter : refresh_token" }) : send(200, { access_token: "Atza|tok", expires_in: 3600 });
    if (u.pathname === "/tokens/2021-03-01/restrictedDataToken") return rdtAllowed ? send(200, { restrictedDataToken: "Atz.sprdt|rdt", expiresIn: 3600 }) : send(403, { errors: [{ code: "Unauthorized", message: "Access to requested resource is denied." }] });
    if (u.pathname === "/orders/2026-01-01/orders") {
      if (!u.searchParams.get("paginationToken")) return send(200, { orders: ORDERS.slice(0, 2), pagination: { nextToken: "p2" } });
      return send(200, { orders: ORDERS.slice(2) });
    }
    if (/\/orders\/v0\/orders\/.+\/shipmentConfirmation/.test(u.pathname)) return send(204);
    if (u.pathname === "/easyShip/2022-03-23/timeSlot") return send(200, { amazonOrderId: "408-2222222-2222222", timeSlots: [{ slotId: "SLOT1", startTime: iso(now + 86400e3), endTime: iso(now + 90000e3), handoverMethod: "PICKUP" }] });
    if (u.pathname === "/easyShip/2022-03-23/package" && req.method === "POST") return send(200, { scheduledPackageId: { amazonOrderId: "408-2222222-2222222", packageId: "PK1" }, packageTimeSlot: { slotId: "SLOT1", startTime: iso(now + 86400e3), endTime: iso(now + 90000e3), handoverMethod: "PICKUP" }, packageStatus: "ReadyForPickup", trackingDetails: { trackingId: "AMZ999" } });
    if (u.pathname === "/easyShip/2022-03-23/package") return send(200, { scheduledPackageId: { amazonOrderId: "408-2222222-2222222" }, packageStatus: "PickedUp", trackingDetails: { trackingId: "AMZ999" } });
    if (u.pathname === "/feeds/2021-06-30/documents" && req.method === "POST") return send(200, { feedDocumentId: "FD1", url: `${base}/upload/FD1` });
    if (u.pathname === "/upload/FD1") return send(200, {});
    if (u.pathname === "/feeds/2021-06-30/feeds" && req.method === "POST") return send(202, { feedId: "F1" });
    if (u.pathname === "/feeds/2021-06-30/feeds/F1") return send(200, feedPolls++ ? { feedId: "F1", processingStatus: "DONE", resultFeedDocumentId: "RD1" } : { feedId: "F1", processingStatus: "IN_PROGRESS" });
    if (u.pathname === "/feeds/2021-06-30/documents/RD1") return send(200, { feedDocumentId: "RD1", url: `${base}/dl/rd1`, compressionAlgorithm: "GZIP" });
    if (u.pathname === "/dl/rd1") {
      res.writeHead(200);
      return res.end(zlib.gzipSync("<Result><DocumentReportReferenceID>DOC-77</DocumentReportReferenceID></Result>"));
    }
    if (u.pathname === "/reports/2021-06-30/documents/DOC-77") return send(200, { reportDocumentId: "DOC-77", url: `${base}/dl/pdf` });
    if (u.pathname === "/dl/pdf") {
      res.writeHead(200);
      return res.end(pdf);
    }
    send(404, { errors: [{ message: "no route " + u.pathname }] });
  });
});

// Stubs: an in-memory order store, items, and documents.
const lean = (v) => ({ lean: async () => v, then: (r, j) => Promise.resolve(v).then(r, j) });
const saved = new Map();
ShopifyOrder.prototype.save = async function () {
  saved.set(this.shopifyId, this);
  return this;
};
ShopifyOrder.findOne = async (q) => saved.get(q.shopifyId) || null;
ShopifyOrder.updateOne = async () => ({});
ShopifyStore.exists = async () => null;
ShopifyStore.findOne = (q) => lean(null);
const ITEMS = [
  { _id: I1, sku: "R4269", name: "Mango wood board", hsnSac: "4419", taxRate: 5, unit: "pcs" },
  { _id: I2, sku: "AFR7342", name: "Iron table", hsnSac: "9403", taxRate: 18, unit: "pcs" },
];
Item.find = () => lean(ITEMS);
Item.findById = async (id) => ITEMS.find((i) => String(i._id) === String(id)) || null;
const customers = [];
Customer.findOne = async (q) => customers.find((c) => (q.gstin ? c.gstin === q.gstin : c.displayName === q.displayName)) || null;
Customer.exists = async () => null;
Customer.create = async (d) => {
  const c = { _id: oid(), ...d };
  customers.push(c);
  return c;
};
Organization.findById = async () => ({ _id: acc.organization, state: "09", gstin: "09ADVFS0745G1ZL" });
Account.findOne = async () => ({ _id: "amz-sales" });
const invoices = [];
require(B + "routes/invoices").createInvoice = async (ctx, body) => {
  const { computeTotals } = require(B + "utils/gst");
  const t = computeTotals({ lineItems: body.lineItems, orgState: "09", placeOfSupply: body.placeOfSupply, adjustment: body.adjustment });
  const inv = { _id: oid(), invoiceNumber: `INV-${invoices.length + 1}`, total: t.total, t, body };
  invoices.push(inv);
  return inv;
};

const acc = {
  _id: oid(), organization: oid(), clientId: "c", clientSecret: "s", refreshToken: "r", sellerId: "A2SELLER", marketplaceId: "A21TJRUUN4KGTV", connected: true, invoiceBy: "ordexago",
  syncFrom: new Date(now - 10 * 86400e3), invoiceFrom: new Date(now - 30 * 86400e3), sync: {}, pii: {}, async save() {}, markModified() {},
};
AmazonAccount.findById = async () => acc;

test.before(async () => {
  await new Promise((r) => srv.listen(0, r));
  base = `http://127.0.0.1:${srv.address().port}`;
  process.env.AMAZON_SPAPI_BASE = base;
  process.env.AMAZON_LWA_URL = `${base}/auth/o2/token`;
  process.env.AMAZON_RETRY_MS = "5";
});
test.after(() => srv.close());

const AO = require(B + "utils/amazon/orders");
const AS = require(B + "utils/amazon/ship");

test("an order item: GST-inclusive prices, promotion as discount, shipping kept apart", () => {
  const { line, shipping, proceeds } = AO.lineOf(ORDERS[0].orderItems[0]);
  assert.deepEqual([line.sku, line.quantity, line.unitPrice, line.discount, line.total, shipping, proceeds], ["R4269", 2, 500, 100, 900, 50, 950]);
  // Tax listed on top of the item price: everything is scaled up to what Amazon pays.
  const x = AO.lineOf({ orderItemId: "a", quantityOrdered: 1, product: {}, proceeds: { proceedsTotal: money(105), breakdowns: [{ type: "ITEM", subtotal: money(100) }, { type: "TAX", subtotal: money(5) }] } });
  assert.equal(x.line.unitPrice, 105);
});

test("sync: self-ship and Easy Ship orders come in; pending ones wait; shipped ones are invoiced", async () => {
  const st = await AO.syncAccount(acc);
  assert.equal(st.error, "");
  assert.deepEqual([st.fetched, st.created, st.invoiced], [4, 3, 1]);
  const search = calls.filter((c) => c.p === "/orders/2026-01-01/orders");
  assert.equal(search[0].tok, "Atz.sprdt|rdt", "buyer details through a restricted data token");
  assert.equal(search[0].q.fulfilledBy, "MERCHANT");
  assert.ok(search[0].q.createdAfter);
  assert.equal(search[1].q.paginationToken, "p2");
  const A = saved.get("amazon:408-1111111-1111111");
  assert.deepEqual([A.channel, A.status, A.total, A.shippingTotal, A.shippingAddress.state, A.paymentMode, String(A.lines[0].item)], ["amazon", "new", 950, 50, "27", "prepaid", String(I1)]);
  assert.ok(A.tags.includes("Self-ship"));
  const E = saved.get("amazon:408-2222222-2222222");
  assert.deepEqual([E.amazon.easyShip, E.paymentMode, E.codAmount, E.amazon.gstin, E.amazon.buyerCompany, String(E.lines[0].item)], [true, "cod", 1180, "19AAACA1234A1Z5", "Asha Traders", String(I2)]);
  assert.equal(saved.has("amazon:408-3333333-3333333"), false);
  const D = saved.get("amazon:408-4444444-4444444");
  assert.deepEqual([D.status, D.shipment.awb, D.invoiceNumber], ["delivered", "DLV123", "INV-1"]);
  assert.ok(acc.lastSyncAt);
});

test("without the restricted role the sync still runs (no buyer details)", async () => {
  rdtAllowed = false;
  acc.pii = { ok: true, checkedAt: new Date(0) };
  const st = await AO.syncAccount(acc);
  assert.equal(st.error, "");
  assert.equal(acc.pii.ok, false);
  const last = calls.filter((c) => c.p === "/orders/2026-01-01/orders").slice(-2)[0];
  assert.equal(last.tok, "Atza|tok");
  assert.ok(last.q.lastUpdatedAfter, "later syncs fetch what changed");
  // Addresses already saved are kept.
  assert.equal(saved.get("amazon:408-1111111-1111111").shippingAddress.address1, "12 MG Road");
  rdtAllowed = true;
});

test("self-ship: the courier and AWB are confirmed to Amazon, then the order is invoiced", async () => {
  const A = saved.get("amazon:408-1111111-1111111");
  A.shipment = { carrier: "custom", courierName: "Blue Dart", awb: "BD12345" };
  A.status = "ready_to_ship";
  const warning = await AS.afterBooked(A);
  assert.equal(warning, "");
  const cb = JSON.parse(calls.find((c) => c.p.endsWith("/shipmentConfirmation")).body);
  assert.equal(cb.marketplaceId, "A21TJRUUN4KGTV");
  assert.deepEqual([cb.packageDetail.carrierCode, cb.packageDetail.trackingNumber, cb.packageDetail.orderItems], ["Blue Dart", "BD12345", [{ orderItemId: "OI-1", quantity: 2 }]]);
  assert.ok(A.amazon.confirmedAt);
  const inv = invoices.find((i) => String(i._id) === String(A.invoice));
  assert.equal(inv.total, 950);
  assert.equal(inv.body.placeOfSupply, "27");
  assert.equal(inv.body.ledger, "amz-sales");
  assert.deepEqual(inv.body.lineItems.map((l) => [l.name, l.quantity, l.discount, l.taxRate]), [["Mango wood board", 2, 10, 5], ["Shipping charges", 1, 0, 5]]);
  assert.equal(customers.find((c) => String(c._id) === inv.body.customer).displayName, "Amazon B2C");
  assert.equal(AS.carrierOf({ courierName: "Delhivery Surface" }).carrierCode, "Delhivery");
  assert.deepEqual(AS.carrierOf({ courierName: "Trackon" }), { carrierCode: "Other", carrierName: "Trackon" });
});

test("Easy Ship: slots, schedule, invoice to the business buyer, Amazon's label", async () => {
  const E = saved.get("amazon:408-2222222-2222222");
  const slots = await AS.handoverSlots(E, { weight: 2, length: 30, breadth: 20, height: 10 });
  assert.equal(slots[0].slotId, "SLOT1");
  const ts = JSON.parse(calls.find((c) => c.p.endsWith("/timeSlot")).body);
  assert.deepEqual([ts.packageWeight, ts.packageDimensions.width], [{ value: 2000, unit: "grams" }, 20]);
  const r = await AS.schedule(E, { slotId: "SLOT1", pkg: { weight: 2, length: 30, breadth: 20, height: 10 } });
  assert.equal(r.warning, "");
  assert.deepEqual([E.status, E.shipment.carrier, E.shipment.awb], ["ready_to_ship", "amazon_easyship", "AMZ999"]);
  const feed = JSON.parse(calls.find((c) => c.p === "/feeds/2021-06-30/feeds" && c.m === "POST").body);
  assert.deepEqual([feed.feedType, feed.inputFeedDocumentId], ["POST_EASYSHIP_DOCUMENTS", "FD1"]);
  const xml = calls.find((c) => c.p === "/upload/FD1").body;
  assert.ok(xml.includes("<MerchantIdentifier>A2SELLER</MerchantIdentifier>") && xml.includes("<AmazonOrderID>408-2222222-2222222</AmazonOrderID>"));
  const inv = invoices.find((i) => String(i._id) === String(E.invoice));
  assert.equal(inv.total, 1180);
  assert.ok(inv.t.igst > 0, "Kolkata from UP is inter-state");
  assert.equal(customers.find((c) => String(c._id) === inv.body.customer).gstin, "19AAACA1234A1Z5");
  assert.equal((await AS.fetchLabel(E)).state, "pending");
  assert.equal((await AS.fetchLabel(E)).state, "ready");
  assert.equal(E.shipment.labelPdf.toString(), pdf.toString());
  assert.equal(E.status, "shipped", "Amazon says it was picked up");
  await assert.rejects(() => require(B + "utils/shopify/ship").bookOrder({ org: "org" }, E, { accountId: "x" }), /Easy Ship/);
});

test("wrong keys give Amazon's reason", async () => {
  const { tokenFor } = require(B + "utils/amazon/client");
  await assert.rejects(() => tokenFor({ clientId: "c", clientSecret: "s", refreshToken: "bad" }), /invalid grant/);
});
