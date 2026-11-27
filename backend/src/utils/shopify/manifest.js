/**
 * Courier handover manifests: which parcels (AWB, order, marketplace, courier, date & time) went to the pickup
 * executive, printed on A5 (or A4) for signature. Orders booked in OrdexaGo and marketplace AWBs recorded at
 * Scan AWB (Amazon / Flipkart / Pepperfry shipped outside OrdexaGo) can both go on a manifest.
 */
const path = require("path");
const PDFDocument = require("pdfkit");
const bwipjs = require("bwip-js");
const ShopifyOrder = require("../../models/ShopifyOrder");
const Manifest = require("../../models/Manifest");
const AwbScan = require("../../models/AwbScan");
const { allShipments } = require("./ship");
const { STATES } = require("../states");

const FONT = path.join(__dirname, "..", "..", "..", "assets", "fonts", "DejaVuSans.ttf");
const BOLD = path.join(__dirname, "..", "..", "..", "assets", "fonts", "DejaVuSans-Bold.ttf");

const CHANNELS = { shopify: "Shopify", amazon: "Amazon", flipkart: "Flipkart", pepperfry: "Pepperfry", other: "Other" };
const channelName = (c) => CHANNELS[String(c || "shopify").toLowerCase()] || String(c);
const up = (s) => String(s || "").trim().toUpperCase();

// AWBs already on a manifest (last 120 days), AWB → manifest number. Read in the app (Oracle's Mongo API).
async function manifested(org) {
  const since = new Date(Date.now() - 120 * 86400000);
  const list = await Manifest.find({ organization: org, createdAt: { $gte: since } }, { number: 1, "rows.awb": 1 }).lean();
  const m = new Map();
  for (const x of list) for (const r of x.rows || []) m.set(up(r.awb), x.number);
  return m;
}

// Rows for an order: every box, or only the box whose AWB was given.
function orderRows(o, onlyAwb) {
  const boxes = allShipments(o);
  const pick = onlyAwb ? boxes.filter((b) => up(b.awb) === onlyAwb) : boxes;
  return (pick.length ? pick : boxes).map((b) => ({
    awb: up(b.awb),
    order: o._id,
    orderName: o.name,
    channel: channelName(o.channel),
    courier: b.courierName || "",
    at: o.awbScannedAt || b.bookedAt || o.statusChangedAt || o.updatedAt,
    box: boxes.length > 1 ? `${boxes.indexOf(b) + 1}/${boxes.length}` : undefined,
  }));
}

/**
 * Codes (AWBs or order numbers) → manifest rows. Unknown AWBs come from the Scan AWB record (marketplace parcels)
 * or take `channel` (and `courier`) as given. Problems come back per code instead of failing the whole list.
 */
async function resolve(org, codes, { channel = "", courier = "" } = {}) {
  const list = [...new Set(codes.map(up).filter(Boolean))].slice(0, 1000);
  const rows = [];
  const problems = [];
  if (!list.length) return { rows, problems };
  const done = await manifested(org);
  const bare = list.map((c) => c.replace(/^#/, ""));
  const names = bare.flatMap((c) => [`#${c}`, c]);
  const nums = bare.filter((c) => /^\d{1,12}$/.test(c)).map(Number);
  const orders = await ShopifyOrder.find({
    organization: org,
    $or: [
      { "shipment.awb": { $in: [...list, ...list.map((c) => c.toLowerCase())] } },
      { "extraShipments.awb": { $in: [...list, ...list.map((c) => c.toLowerCase())] } },
      { name: { $in: names } },
      ...(nums.length ? [{ orderNumber: { $in: nums } }] : []),
    ],
  }).lean();
  const scans = await AwbScan.find({ organization: org, code: { $in: list }, matched: false }).lean();
  const seen = new Set();
  for (const code of list) {
    const b = code.replace(/^#/, "");
    let o = orders.find((x) => allShipments(x).some((s) => up(s.awb) === code));
    const byAwb = !!o;
    if (!o) o = orders.find((x) => up(x.name).replace(/^#/, "") === b || String(x.orderNumber) === b);
    let got = [];
    if (o) {
      if (o.status === "cancelled") {
        problems.push({ code, message: `${o.name} is cancelled — don't hand it over` });
        continue;
      }
      if (!allShipments(o).length) {
        problems.push({ code, message: `${o.name} isn't booked with a courier yet (no AWB)` });
        continue;
      }
      got = orderRows(o, byAwb ? code : null);
    } else {
      if (!/^[A-Z0-9-]{6,40}$/.test(code)) {
        problems.push({ code, message: `"${code}" doesn't look like an AWB` });
        continue;
      }
      const sc = scans.find((s) => s.code === code);
      const ch = sc?.channel || channel;
      if (!ch) {
        problems.push({ code, message: `${code} isn't an order in OrdexaGo — pick its marketplace (Amazon / Flipkart / Pepperfry / Other) and add it again` });
        continue;
      }
      got = [{ awb: code, orderName: "", channel: channelName(ch), courier: sc?.courier || courier || "", at: sc?.at || new Date() }];
    }
    for (const r of got) {
      if (seen.has(r.awb)) continue;
      seen.add(r.awb);
      if (done.has(r.awb)) problems.push({ code: r.awb, message: `${r.awb}${r.orderName ? ` (${r.orderName})` : ""} is already on manifest ${done.get(r.awb)}` });
      else rows.push(r);
    }
  }
  return { rows, problems };
}

/**
 * Parcels waiting for a manifest: booked orders (Ready to Ship / AWB scanned, or shipped in the last `days`) and
 * marketplace AWBs scanned at handover, not yet on a manifest.
 */
async function pending(org, { days = 3 } = {}) {
  const since = new Date(Date.now() - Math.min(Math.max(Number(days) || 3, 1), 30) * 86400000);
  const done = await manifested(org);
  const [ready, shipped, scans] = await Promise.all([
    ShopifyOrder.find({ organization: org, status: "ready_to_ship" }).lean(),
    ShopifyOrder.find({ organization: org, status: "shipped", statusChangedAt: { $gte: since } }).lean(),
    AwbScan.find({ organization: org, matched: false, at: { $gte: since } }).lean(),
  ]);
  const rows = [];
  for (const o of [...ready, ...shipped]) for (const r of orderRows(o)) if (!done.has(r.awb)) rows.push({ ...r, status: o.status, scanned: !!o.awbScannedAt });
  const seen = new Set(rows.map((r) => r.awb));
  for (const s of scans)
    if (!done.has(s.code) && !seen.has(s.code)) {
      seen.add(s.code);
      rows.push({ awb: s.code, orderName: "", channel: channelName(s.channel), courier: s.courier || "", at: s.at, scanned: true });
    }
  return rows.sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0));
}

const one = (rows, k) => {
  const v = [...new Set(rows.map((r) => r[k]).filter(Boolean))];
  return v.length === 1 ? v[0] : v.length ? "Multiple" : "";
};

async function create(org, user, { rows, note = "" }) {
  const { nextNumber } = require("../../models/Counter");
  const number = await nextNumber(org, "manifest", "MF-", 5);
  return Manifest.create({
    organization: org,
    number,
    rows,
    count: rows.length,
    courier: one(rows, "courier"),
    channel: one(rows, "channel"),
    note,
    createdBy: user?._id,
    createdByName: user?.name || "",
  });
}

// "27/11/26 18:34" (IST)
const fmtAt = (t) => {
  if (!t) return "";
  const d = new Date(new Date(t).getTime() + 5.5 * 3600000).toISOString();
  return `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(2, 4)} ${d.slice(11, 16)}`;
};

function toBuffer(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.end();
  });
}

// The printed manifest: A5 portrait by default (A4 on request), header repeated on every page, signatures at the end.
async function manifestPdf(org, m, paper = "A5") {
  const a5 = paper !== "A4";
  const doc = new PDFDocument({ size: a5 ? "A5" : "A4", margin: a5 ? 22 : 36, bufferPages: true });
  doc.registerFont("r", FONT);
  doc.registerFont("b", BOLD);
  const L = doc.page.margins.left;
  const W = doc.page.width - 2 * L;
  const s = a5 ? 1 : 1.25; // type scale
  const barcode = await bwipjs.toBuffer({ bcid: "code128", text: m.number, scale: 2, height: 8, includetext: false }).catch(() => null);
  const a = org.address || {};
  const addr = [a.street, a.city, [(STATES.find(([k]) => k === a.state) || [])[1] || a.state, a.pincode].filter(Boolean).join(" ")].filter((x) => x && String(x).trim()).join(", ");

  // Columns: # · AWB · Order · Marketplace · Courier · Date & time
  const cols = [
    ["#", 0.05, "right"],
    ["AWB Number", 0.25],
    ["Order No.", 0.155],
    ["Marketplace", 0.155],
    ["Courier", 0.21],
    ["Date & Time", 0.18],
  ].map(([t, w, align]) => ({ t, w: w * W, align: align || "left" }));
  const rowH = 13 * s;

  const head = (first) => {
    let y = doc.page.margins.top;
    doc.font("b").fontSize(11 * s).fillColor("#111827").text(org.name || "", L, y, { width: W * 0.62 });
    doc.font("r").fontSize(6.5 * s).fillColor("#4b5563");
    if (addr) doc.text(addr, L, doc.y, { width: W * 0.62 });
    const contact = [org.gstin && `GSTIN ${org.gstin}`, org.phone].filter(Boolean).join(" · ");
    if (contact) doc.text(contact, L, doc.y, { width: W * 0.62 });
    const leftBottom = doc.y;
    doc.font("b").fontSize(13 * s).fillColor("#111827").text("COURIER MANIFEST", L, y, { width: W, align: "right" });
    doc.font("b").fontSize(8.5 * s).text(m.number, L, doc.y, { width: W, align: "right" });
    if (barcode) doc.image(barcode, L + W - 90 * s, doc.y + 1, { width: 90 * s, height: 14 * s });
    y = Math.max(leftBottom, doc.y + 16 * s) + 6;
    if (first) {
      const facts = [
        ["Date & Time", fmtAt(m.createdAt)],
        ["Courier", m.courier || "—"],
        ["Marketplace", m.channel || "—"],
        ["Total parcels", String(m.count || m.rows.length)],
      ];
      const fws = [0.27, 0.3, 0.25, 0.18].map((f) => f * W);
      doc.rect(L, y, W, 26 * s).fillColor("#f3f4f6").fill();
      let fx = L;
      facts.forEach(([k, v], i) => {
        doc.font("r").fontSize(6 * s).fillColor("#6b7280").text(k.toUpperCase(), fx + 5, y + 4 * s, { width: fws[i] - 8 });
        doc.font("b").fontSize(8 * s).fillColor("#111827").text(v, fx + 5, y + 12 * s, { width: fws[i] - 8, height: 11 * s, ellipsis: true });
        fx += fws[i];
      });
      y += 26 * s + 6;
    }
    // Column heads
    doc.rect(L, y, W, rowH).fillColor("#111827").fill();
    let x = L;
    doc.font("b").fontSize(6.8 * s).fillColor("#ffffff");
    for (const c of cols) {
      doc.text(c.t, x + 3, y + 3.5 * s, { width: c.w - 6, align: c.align, lineBreak: false });
      x += c.w;
    }
    return y + rowH;
  };

  let y = head(true);
  const bottom = () => doc.page.height - doc.page.margins.bottom - 14;
  m.rows.forEach((r, i) => {
    if (y + rowH > bottom()) {
      doc.addPage();
      y = head(false);
    }
    if (i % 2) doc.rect(L, y, W, rowH).fillColor("#f9fafb").fill();
    const vals = [String(i + 1), r.awb, `${r.orderName || "—"}${r.box ? ` (${r.box})` : ""}`, r.channel || "", r.courier || "", fmtAt(r.at)];
    let x = L;
    cols.forEach((c, k) => {
      doc.font(k === 1 ? "b" : "r").fontSize((k === 1 ? 7.6 : k === 4 ? 6.4 : 7) * s).fillColor("#111827");
      doc.text(vals[k], x + 3, y + 3.5 * s, { width: c.w - 6, align: c.align, lineBreak: false, ellipsis: true, height: rowH });
      x += c.w;
    });
    doc.moveTo(L, y + rowH).lineTo(L + W, y + rowH).strokeColor("#e5e7eb").lineWidth(0.5).stroke();
    y += rowH;
  });

  // Totals by courier, note, signatures
  const need = 78 * s;
  if (y + need > bottom()) {
    doc.addPage();
    y = doc.page.margins.top;
  }
  y += 8;
  const by = {};
  for (const r of m.rows) by[r.courier || "—"] = (by[r.courier || "—"] || 0) + 1;
  doc.font("b").fontSize(7.5 * s).fillColor("#111827").text(`Total ${m.rows.length} parcel${m.rows.length === 1 ? "" : "s"}` + (Object.keys(by).length > 1 ? `  (${Object.entries(by).map(([c, n]) => `${c}: ${n}`).join(", ")})` : ""), L, y, { width: W });
  if (m.note) doc.font("r").fontSize(7 * s).fillColor("#374151").text(`Note: ${m.note}`, L, doc.y + 2, { width: W });
  y = doc.y + 26 * s;
  const half = (W - 16) / 2;
  [["Handed over by", m.createdByName], ["Received by (courier executive)", ""]].forEach(([t, n], i) => {
    const x = L + i * (half + 16);
    doc.moveTo(x, y).lineTo(x + half, y).strokeColor("#111827").lineWidth(0.7).stroke();
    doc.font("b").fontSize(7 * s).fillColor("#111827").text(t, x, y + 3, { width: half });
    doc.font("r").fontSize(6.5 * s).fillColor("#6b7280").text(i ? "Name, signature, date & time" : `${n ? `${n} · ` : ""}signature`, x, doc.y + 1, { width: half });
  });

  const range = doc.bufferedPageRange();
  for (let p = range.start; p < range.start + range.count; p++) {
    doc.switchToPage(p);
    doc.font("r").fontSize(6 * s).fillColor("#9ca3af").text(`${m.number} · Page ${p + 1} of ${range.count} · OrdexaGo`, L, doc.page.height - doc.page.margins.bottom - 8, { width: W, align: "center", lineBreak: false });
  }
  return toBuffer(doc);
}

module.exports = { resolve, pending, create, manifestPdf, channelName };
