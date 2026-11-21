/**
 * Seller support tickets: shared by the seller's dashboard (routes/sellerPortal.js) and the team's desk
 * (routes/tickets.js). Screenshots go to GridFS ("attachments" bucket), like payment proofs.
 */
const mongoose = require("mongoose");
const SupportTicket = require("../models/SupportTicket");
const { HttpError } = require("./http");

const CATEGORIES = [
  ["order", "Order problem"],
  ["shipping", "Pickup / shipping / label"],
  ["return", "Return / RTO"],
  ["payment", "Payment / settlement / deduction"],
  ["stock", "Stock / product listing"],
  ["technical", "Technical problem on the dashboard"],
  ["account", "Account / login"],
  ["other", "Something else"],
];
const STATUSES = [
  ["open", "Open"],
  ["in_progress", "Work in progress"],
  ["waiting", "Waiting for seller"],
  ["resolved", "Resolved"],
  ["closed", "Closed"],
];
const PRIORITIES = ["low", "normal", "high", "urgent"];
const LABEL = Object.fromEntries(STATUSES);
const CAT = Object.fromEntries(CATEGORIES);
const bucket = () => new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: "attachments" });
const FILE_RX = /^(image\/|application\/pdf)|\.(png|jpe?g|webp|gif|heic|heif|pdf)$/i;

// [{ name, type, data (base64) }] → saved files (max 5, 10 MB each).
async function saveFiles(org, files = []) {
  const out = [];
  for (const f of files.slice(0, 5)) {
    const buf = Buffer.from(String(f.data || "").replace(/^data:.*?;base64,/, ""), "base64");
    if (!buf.length) continue;
    if (buf.length > 10 * 1024 * 1024) throw new HttpError(400, `${f.name}: files can be up to 10 MB`);
    if (!FILE_RX.test(f.type || "") && !FILE_RX.test(f.name || "")) throw new HttpError(400, `${f.name}: add a screenshot (image) or a PDF`);
    const type = f.type || (/\.pdf$/i.test(f.name) ? "application/pdf" : "image/jpeg");
    const fileId = new mongoose.Types.ObjectId();
    const { Readable } = require("stream");
    await new Promise((resolve, reject) => Readable.from(buf).pipe(bucket().openUploadStreamWithId(fileId, f.name || "screenshot.png", { metadata: { organization: org, type, ticket: true } })).on("finish", resolve).on("error", reject));
    out.push({ fileId, name: f.name || "screenshot.png", type, size: buf.length });
  }
  return out;
}

function streamFile(t, fileId, res, { seller = false } = {}) {
  const f = (t.messages || []).flatMap((m) => (m.internal && seller ? [] : m.files || [])).find((x) => String(x._id) === String(fileId) || String(x.fileId) === String(fileId));
  if (!f) throw new HttpError(404, "File not found");
  res.setHeader("Content-Type", f.type || "application/octet-stream");
  res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(f.name)}"`);
  bucket().openDownloadStream(f.fileId).on("error", () => res.status(404).end()).pipe(res);
}

async function nextNumber(org) {
  const last = await SupportTicket.findOne({ organization: org }, { number: 1 }).sort({ number: -1 }).lean();
  return (last?.number || 0) + 1;
}

async function create(org, seller, user, d) {
  const files = await saveFiles(org, d.files);
  for (let i = 0; i < 3; i++) {
    try {
      return await SupportTicket.create({
        organization: org,
        number: await nextNumber(org),
        seller: seller._id,
        sellerName: seller.name,
        raisedBy: { user: user?._id, name: user?.name || seller.name, email: user?.email || seller.email || "" },
        category: CAT[d.category] ? d.category : "other",
        subject: d.subject,
        order: d.order?._id,
        orderName: d.order?.name || "",
        priority: d.priority && PRIORITIES.includes(d.priority) ? d.priority : "normal",
        messages: [{ from: "seller", user: user?._id, name: user?.name || seller.name, text: d.text, files }],
        lastFrom: "seller",
        teamUnread: 1,
      });
    } catch (e) {
      if (e.code !== 11000 || i === 2) throw e; // two tickets at once: take the next number
    }
  }
}

const ticketNo = (t) => `TKT-${String(t.number).padStart(4, "0")}`;

// What the seller sees: no internal notes, no assignee details beyond a name.
function sellerView(t, full = false) {
  const msgs = (t.messages || []).filter((m) => !m.internal);
  return {
    _id: t._id,
    number: ticketNo(t),
    subject: t.subject,
    category: t.category,
    categoryLabel: CAT[t.category] || t.category,
    orderName: t.orderName,
    status: t.status,
    statusLabel: LABEL[t.status],
    createdAt: t.createdAt,
    lastActivityAt: t.lastActivityAt,
    unread: t.sellerUnread || 0,
    replies: msgs.length - 1,
    ...(full ? { messages: msgs.map((m) => ({ _id: m._id, from: m.from, name: m.from === "team" ? `${m.name} (Support)` : m.name, text: m.text, files: m.files, at: m.at })) } : {}),
  };
}

// Email the seller when the team answers or resolves (best effort).
async function notifySeller(t, what) {
  const to = t.raisedBy?.email;
  if (!to) return;
  try {
    const { sendSystemMail } = require("./mailer");
    const last = [...t.messages].reverse().find((m) => !m.internal && m.from !== "seller");
    const body = [`Hello ${t.raisedBy?.name || t.sellerName},`, "", `${what} on your support ticket ${ticketNo(t)} — ${t.subject}.`, last?.text ? `\n"${last.text.slice(0, 1500)}"\n` : "", `Status: ${LABEL[t.status]}`, "", "Open your seller dashboard → Support to reply."].join("\n");
    await sendSystemMail(to, `${ticketNo(t)}: ${what} — ${t.subject}`, body);
  } catch {
    /* email is a courtesy; the ticket is on the dashboard */
  }
}

module.exports = { CATEGORIES, STATUSES, PRIORITIES, LABEL, CAT, saveFiles, streamFile, create, sellerView, ticketNo, notifySeller };
