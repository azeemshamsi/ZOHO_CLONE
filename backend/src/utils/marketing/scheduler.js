/**
 * Background work for the Inbox and marketing (started with the app's other timers in utils/recurring.js):
 *   WhatsApp order updates listener · Gmail poll every 2 min · campaigns every 30 s ·
 *   Shopify marketing consent hourly · retention clean-up daily (messages 2 years, media 180 days by default).
 */
const DAY = 86400000;

async function purgeRetention(now = Date.now()) {
  const MarketingConfig = require("../../models/MarketingConfig");
  const Message = require("../../models/Message");
  const Conversation = require("../../models/Conversation");
  const { purgeMedia } = require("./media");
  const mongoose = require("mongoose");
  const orgs = new Set((await Conversation.find({}, { organization: 1 }).lean()).map((c) => String(c.organization)));
  const cfgs = new Map((await MarketingConfig.find({}).lean()).map((c) => [String(c.organization), c]));
  for (const org of orgs) {
    const r = cfgs.get(org)?.retention || {};
    const msgDays = Math.max(30, Number(r.messagesDays) || 730);
    const mediaDays = Math.max(7, Number(r.mediaDays) || 180);
    const oid = new mongoose.Types.ObjectId(org);
    await Message.deleteMany({ organization: oid, at: { $lt: new Date(now - msgDays * DAY) } });
    await Conversation.deleteMany({ organization: oid, lastMessageAt: { $lt: new Date(now - msgDays * DAY) } });
    const n = await purgeMedia(org, mediaDays).catch(() => 0);
    if (n) {
      const old = await Message.find({ organization: oid, at: { $lt: new Date(now - mediaDays * DAY) }, "media.0": { $exists: true } }, { media: 1 }).lean();
      for (const m of old) await Message.updateOne({ _id: m._id }, { $set: { media: m.media.map((x) => ({ ...x, url: "", fileId: undefined, removed: true })) } });
    }
  }
}

let started = false;
function start() {
  if (started || process.env.NODE_ENV === "test") return;
  started = true;
  require("./orderUpdates").start();
  const gmail = () => require("./gmail").pollAll().catch((e) => console.error("Gmail poll failed:", e.message));
  setTimeout(gmail, 30000).unref();
  setInterval(gmail, 2 * 60 * 1000).unref();
  setInterval(() => require("./campaigns").tick().catch((e) => console.error("Campaigns failed:", e.message)), 30 * 1000).unref();
  const consent = () => require("./audience").syncAllConsent().catch((e) => console.error("Consent sync failed:", e.message));
  setTimeout(consent, 90 * 1000).unref();
  setInterval(consent, 60 * 60 * 1000).unref();
  const purge = () => purgeRetention().catch((e) => console.error("Inbox retention failed:", e.message));
  setTimeout(purge, 5 * 60 * 1000).unref();
  setInterval(purge, DAY).unref();
}

module.exports = { start, purgeRetention };
