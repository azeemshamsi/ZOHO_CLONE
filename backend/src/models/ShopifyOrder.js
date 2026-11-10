const mongoose = require("mongoose");

const addr = {
  name: String,
  company: String,
  address1: String,
  address2: String,
  city: String,
  province: String,
  state: String, // GST state code
  zip: String,
  country: String,
  phone: String,
};

const lineSchema = new mongoose.Schema(
  {
    lineId: String,
    productId: String,
    variantId: String,
    title: String,
    variantTitle: String,
    sku: String,
    vendor: String,
    productType: String,
    category: String, // Shopify taxonomy category
    tags: [String],
    image: String,
    hsn: String, // from Shopify (inventory item)
    shopifyTaxRate: Number, // sum of the line's tax lines
    quantity: Number, // current quantity (after removals)
    unitPrice: Number, // list price per unit, GST inclusive
    discount: Number, // all discounts allocated to the line
    total: Number, // after discounts, GST inclusive
    item: { type: mongoose.Schema.Types.ObjectId, ref: "Item" },
  },
  { _id: false }
);

const eventSchema = new mongoose.Schema({ at: Date, status: String, location: String }, { _id: false });

const shopifyOrderSchema = new mongoose.Schema(
  {
    organization: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", required: true },
    shopifyId: { type: String, required: true }, // gid://shopify/Order/123, or "amazon:<order id>" for Amazon orders
    channel: { type: String, enum: ["shopify", "amazon", "flipkart"], default: "shopify" },
    // Amazon order details: { account, orderId, marketplaceId, easyShip, programs, fulfillmentStatus, serviceLevel,
    // shipBy, deliverBy, gstin, buyerCompany, items [{orderItemId, sku, quantity}], confirmedAt, confirmError,
    // packageStatus, slot {slotId, start, end, method}, scheduledAt, label {feedId, state, error, at} }
    amazon: { type: mongoose.Schema.Types.Mixed },
    // Flipkart shipment ("flipkart:<shipmentId>"): { account, shipmentId, orderId, state, selfShip, locationId, items
    // [{orderItemId, orderId, sku, quantity, status}], subShipments, courier, packedAt, rtdAt, dispatchReportedAt… }
    flipkart: { type: mongoose.Schema.Types.Mixed },
    name: String, // "#1001"
    orderNumber: Number,
    orderDate: Date,
    shopifyUpdatedAt: Date,
    customer: { name: String, email: String, phone: String },
    shippingAddress: addr,
    billingAddress: addr,
    financialStatus: String, // PAID, PENDING, REFUNDED…
    fulfillmentStatus: String, // UNFULFILLED, FULFILLED…
    cancelledAt: Date,
    cancelReason: String,
    paymentMode: { type: String, enum: ["cod", "prepaid", "partial"], default: "prepaid" },
    prepaidAmount: { type: Number, default: 0 }, // paid online
    codAmount: { type: Number, default: 0 }, // to collect on delivery
    gateways: [String],
    tags: [String],
    note: String,
    currency: String,
    subtotal: Number,
    discount: Number,
    shippingTotal: Number,
    tax: Number,
    total: Number, // current total (after edits/refunds)
    outstanding: Number,
    lines: [lineSchema],
    shopifyFulfillments: [{ _id: false, company: String, number: String, url: String }],
    // OrdexaGo workflow
    status: { type: String, enum: ["new", "packed", "ready_to_ship", "shipped", "delivered", "rto", "return_created", "returned", "cancelled"], default: "new" },
    returnStatus: String, // Shopify's
    shopifyReturnId: String,
    returnedAt: Date,
    returnNote: String,
    returnCreditNote: { type: mongoose.Schema.Types.ObjectId, ref: "CreditNote" },
    // Shopify return + credit note, finished in the background after a scan.
    returnSync: { state: String, message: String, creditNoteNumber: String, at: Date },
    statusChangedAt: Date,
    shipment: {
      account: { type: mongoose.Schema.Types.ObjectId, ref: "CourierAccount" },
      carrier: String, // shiprocket, delhivery…
      courierName: String, // what's printed (e.g. "Delhivery Surface" via Shiprocket)
      awb: String,
      labelUrl: String,
      labelPdf: { type: Buffer, select: false }, // label returned at booking (Blue Dart)
      trackingUrl: String,
      refs: { type: mongoose.Schema.Types.Mixed }, // carrier ids (shipment_id etc.)
      weight: Number,
      length: Number,
      breadth: Number,
      height: Number,
      packageName: String,
      charge: Number, // expected courier charge at booking
      chargeSource: String, // "api" or "rate card"
      bookedAt: Date,
      trackStatus: String,
      trackedAt: Date,
      events: [eventSchema],
      pickup: { type: mongoose.Schema.Types.Mixed }, // where it was picked up from (a marketplace seller's address)
      seller: { type: mongoose.Schema.Types.ObjectId, ref: "Seller" },
      shopifyFulfilled: Boolean,
      error: String,
    },
    deliveredAt: Date, // when it was delivered (for sellers' monthly purchase orders)
    deliveredChecked: Boolean, // deliveredAt confirmed from Shopify's fulfilment
    // Marketplace sellers whose products are on this order (from each line's Shopify Vendor) and what was settled.
    sellers: { type: [mongoose.Schema.Types.ObjectId], default: [] },
    // excluded: settled outside OrdexaGo (e.g. paid in the old software) — never goes on a purchase order.
    sellerSettled: [{ _id: false, seller: mongoose.Schema.Types.ObjectId, purchaseOrder: mongoose.Schema.Types.ObjectId, number: String, organization: mongoose.Schema.Types.ObjectId, amount: Number, at: Date, excluded: Boolean, reason: String, by: mongoose.Schema.Types.ObjectId }],
    invoice: { type: mongoose.Schema.Types.ObjectId, ref: "Invoice" },
    invoiceNumber: String,
    invoiceOrg: { type: mongoose.Schema.Types.ObjectId, ref: "Organization" }, // the company the invoice is in
    invoiceError: String,
    remarks: String,
    // B2B: the buyer's GSTIN and registered name, entered on the order; its invoice goes to that registered customer.
    b2b: { gstin: String, name: String, at: Date, by: { type: mongoose.Schema.Types.ObjectId, ref: "User" } },
    // AWB scanned by us before handing the parcel to the courier (internal record): latest scan + every scan.
    awbScannedAt: Date,
    awbScannedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    awbScans: [{ _id: false, awb: String, courier: String, at: Date, by: mongoose.Schema.Types.ObjectId, byName: String }],
    // Shipments booked and cancelled: a new booking then uses "<order>-2", "-3"… as the courier's order reference
    // (couriers refuse a reference they have seen before).
    cancelledShipments: [{ _id: false, courier: String, awb: String, at: Date }],
    returnFrom: String, // status before the return was opened (to go back to if it's declined)
    // COD order confirmed / cancel requested by the buyer with the WhatsApp buttons (Marketing → Automations).
    // A cancel request only flags the order for staff; it is never cancelled automatically.
    codConfirm: { state: String, at: Date, via: String },
  },
  { timestamps: true }
);
shopifyOrderSchema.index({ organization: 1, shopifyId: 1 }, { unique: true });
shopifyOrderSchema.index({ organization: 1, status: 1, orderDate: -1 });
shopifyOrderSchema.index({ organization: 1, orderDate: -1 });
shopifyOrderSchema.index({ organization: 1, "shipment.awb": 1 });
shopifyOrderSchema.index({ organization: 1, name: 1 });
shopifyOrderSchema.index({ organization: 1, orderNumber: 1 });
shopifyOrderSchema.index({ organization: 1, updatedAt: -1 });
shopifyOrderSchema.index({ organization: 1, sellers: 1, orderDate: -1 });

// Keep `sellers` in step with the lines' Shopify Vendor, and note when an order is delivered.
shopifyOrderSchema.pre("save", async function () {
  const { sellersOfLines } = require("../utils/sellers");
  const ids = await sellersOfLines(this.organization, this.lines || []);
  if (ids.map(String).sort().join() !== (this.sellers || []).map(String).sort().join()) this.sellers = ids;
  if (this.status === "delivered" && !this.deliveredAt) {
    const ev = (this.shipment?.events || []).filter((e) => /deliver/i.test(e.status || "") && !/undeliver|not deliver/i.test(e.status || "") && e.at && !isNaN(e.at)).sort((a, b) => b.at - a.at)[0];
    // Best guess until Shopify's own delivery time is read (refreshDeliveries sets it and deliveredChecked).
    this.deliveredAt = ev?.at || (this.isModified("status") ? new Date() : this.statusChangedAt || new Date());
  }
});

// Status changes → utils/marketing/orderEvents (WhatsApp order updates). Listeners run after the save, in the
// background: they can never block or fail the change itself.
shopifyOrderSchema.post("init", function () {
  this.$locals.orig = { status: this.status, track: this.shipment?.trackStatus || "", awb: this.shipment?.awb || "" };
});
shopifyOrderSchema.pre("save", function () {
  const o = this.$locals.orig || {};
  this.$locals.change = { isNew: this.isNew, prevStatus: this.isNew ? "" : o.status || "", status: this.status, prevTrack: this.isNew ? "" : o.track || "", track: this.shipment?.trackStatus || "", awb: this.shipment?.awb || "" };
});
shopifyOrderSchema.post("save", function (doc) {
  const ch = doc.$locals.change;
  doc.$locals.orig = { status: doc.status, track: doc.shipment?.trackStatus || "", awb: doc.shipment?.awb || "" };
  if (!ch || (!ch.isNew && ch.prevStatus === ch.status && ch.prevTrack === ch.track)) return;
  try {
    require("../utils/marketing/orderEvents").emitChange(doc, ch);
  } catch (e) {
    console.error(`[order events] ${e.message}`);
  }
});

module.exports = mongoose.model("ShopifyOrder", shopifyOrderSchema);
