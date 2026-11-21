const mongoose = require("mongoose");

// A product a marketplace seller uploaded from their dashboard (listing file). It becomes a DRAFT product on Shopify;
// the team checks it, sets the selling price and approves it (made active on the website) or rejects it.
const variantSchema = new mongoose.Schema(
  {
    sku: String,
    options: [String], // values for the listing's options, in order
    price: Number, // the seller's suggested selling price
    compareAtPrice: Number, // MRP
    cost: Number, // the seller's price to us ("Cost per item")
    grams: Number,
    qty: Number,
    barcode: String,
    hsn: String,
    gst: Number,
    shopifyVariantId: String,
    finalPrice: Number, // our selling price, set at approval
    finalCompareAt: Number,
  },
  { _id: false },
);

const sellerListingSchema = new mongoose.Schema(
  {
    organization: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
    },
    seller: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Seller",
      required: true,
      index: true,
    },
    sellerName: String,
    batch: { type: String, index: true }, // one upload
    fileName: String,
    row: Number, // first row of the product in the file
    brand: String, // Shopify Vendor
    handle: String,
    title: String,
    descriptionHtml: String,
    productType: String,
    tags: [String],
    options: [{ _id: false, name: String, values: [String] }],
    variants: [variantSchema],
    images: [{ _id: false, src: String, alt: String }],
    seoTitle: String,
    seoDescription: String,
    size: { length: Number, breadth: Number, height: Number }, // packed, cm
    // queued → creating → draft (on Shopify, waiting for review) → approved | rejected; failed: Shopify refused it
    status: {
      type: String,
      enum: ["queued", "creating", "draft", "failed", "approved", "rejected"],
      default: "queued",
      index: true,
    },
    shopifyId: String,
    shopifyHandle: String,
    error: String,
    reason: String, // why it was rejected
    submittedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    reviewedByName: String,
    reviewedAt: Date,
  },
  { timestamps: true },
);
module.exports = mongoose.model("SellerListing", sellerListingSchema);
