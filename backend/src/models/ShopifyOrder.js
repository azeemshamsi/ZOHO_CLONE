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
    shopifyId: { type: String, required: true }, // gid://shopify/Order/123
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
      bookedAt: Date,
      trackStatus: String,
      trackedAt: Date,
      events: [eventSchema],
      shopifyFulfilled: Boolean,
      error: String,
    },
    invoice: { type: mongoose.Schema.Types.ObjectId, ref: "Invoice" },
    invoiceNumber: String,
    invoiceOrg: { type: mongoose.Schema.Types.ObjectId, ref: "Organization" }, // the company the invoice is in
    invoiceError: String,
    remarks: String,
  },
  { timestamps: true }
);
shopifyOrderSchema.index({ organization: 1, shopifyId: 1 }, { unique: true });
shopifyOrderSchema.index({ organization: 1, status: 1, orderDate: -1 });
shopifyOrderSchema.index({ organization: 1, orderDate: -1 });
shopifyOrderSchema.index({ organization: 1, "shipment.awb": 1 });

module.exports = mongoose.model("ShopifyOrder", shopifyOrderSchema);
