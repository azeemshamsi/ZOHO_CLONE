const mongoose = require("mongoose");

/**
 * Inbox + marketing settings for a company: WhatsApp order updates, business hours, away message,
 * built-in order-status reply, AI drafts and data retention.
 *
 * orderUpdates[event] = { enabled, template, language, params: [var], headerParam, urlButtonParam }
 *   events: order_placed, cod_confirmation, shipped, out_for_delivery, delivered, rto
 *   vars:   customer_name, order_no, amount, courier, awb, tracking_url, payment_mode, cod_amount, store_name
 */
const EVENTS = ["order_placed", "cod_confirmation", "shipped", "out_for_delivery", "delivered", "rto"];
const eventSchema = new mongoose.Schema(
  {
    enabled: { type: Boolean, default: false },
    template: { type: String, default: "" },
    language: { type: String, default: "en" },
    params: { type: [String], default: [] }, // body {{1}}, {{2}}… in order
    headerParam: { type: String, default: "" }, // a text header's {{1}}
    urlButtonParam: { type: String, default: "" }, // a URL button's dynamic suffix (button index 0)
  },
  { _id: false }
);

const configSchema = new mongoose.Schema(
  {
    organization: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", required: true, unique: true },
    orderUpdates: { type: Object.fromEntries(EVENTS.map((e) => [e, { type: eventSchema, default: () => ({}) }])), default: () => ({}) },
    shippedOn: { type: String, enum: ["booked", "picked"], default: "picked" }, // "shipped" message: when booked, or when the courier picks it up
    businessHours: {
      enabled: { type: Boolean, default: false },
      // 0 = Sunday … 6 = Saturday; times "HH:MM" in India time
      days: { type: [{ _id: false, day: Number, open: String, close: String }], default: () => [1, 2, 3, 4, 5, 6].map((day) => ({ day, open: "10:00", close: "19:00" })) },
    },
    away: { enabled: { type: Boolean, default: false }, text: { type: String, default: "Thanks for your message! We're closed right now and will reply when we're back." }, channels: { type: [String], default: ["whatsapp", "messenger", "instagram"] } },
    orderStatusReply: { enabled: { type: Boolean, default: false }, channels: { type: [String], default: ["whatsapp", "messenger", "instagram"] } },
    ai: { enabled: { type: Boolean, default: true }, autoDraft: { type: Boolean, default: false }, autoSend: { type: [String], default: [] }, instructions: { type: String, default: "" } },
    stopKeywords: { type: [String], default: ["STOP", "UNSUBSCRIBE"] },
    retention: { messagesDays: { type: Number, default: 730 }, mediaDays: { type: Number, default: 180 } },
    campaignRatePerMinute: { type: Number, default: 60 },
  },
  { timestamps: true, minimize: false }
);

module.exports = mongoose.model("MarketingConfig", configSchema);
module.exports.EVENTS = EVENTS;
