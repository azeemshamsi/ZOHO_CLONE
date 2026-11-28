/**
 * COD Pending (Store → COD Pending): money couriers have collected (or will collect) on COD and part-paid orders
 * and not yet paid us. Orders from 1 April 2026 only.
 *  - Delivered → the courier has the cash: pending until marked received (by hand or a remittance file).
 *  - In transit (shipped) → still to be collected.
 *  - Returned after delivery counts as delivered (the courier collected the COD); RTO / cancelled / not shipped
 *    don't count.
 */
const XLSX = require("xlsx");
const ShopifyOrder = require("../../models/ShopifyOrder");
const CourierAccount = require("../../models/CourierAccount");
const { round2 } = require("../http");

const START = new Date("2026-04-01T00:00:00+05:30");
const ymd = (d) => (d ? new Date(new Date(d).getTime() + 5.5 * 3600000).toISOString().slice(0, 10) : "");
const up = (s) => String(s || "").trim().toUpperCase();

const FIELDS = { name: 1, orderNumber: 1, orderDate: 1, status: 1, paymentMode: 1, codAmount: 1, outstanding: 1, total: 1, prepaidAmount: 1, deliveredAt: 1, statusChangedAt: 1, shipment: 1, extraShipments: 1, codRemit: 1, customerName: 1, "shippingAddress.name": 1, "shippingAddress.city": 1 };

function stageOf(o) {
  if (o.status === "delivered") return "delivered";
  if (["return_created", "returned"].includes(o.status) && o.deliveredAt) return "delivered";
  if (o.status === "shipped") return "in_transit";
  return null;
}
const amountOf = (o) => round2(o.codAmount > 0 ? o.codAmount : o.paymentMode === "partial" || o.paymentMode === "cod" ? o.outstanding || 0 : 0);
const awbsOf = (o) => [o.shipment?.awb, ...(o.extraShipments || []).map((s) => s?.awb)].filter(Boolean).map(up);

let accCache = { at: 0, org: "", map: new Map() };
async function accountNames(org) {
  if (accCache.org === String(org) && Date.now() - accCache.at < 60000) return accCache.map;
  const list = await CourierAccount.find({ organization: org }, { name: 1, carrier: 1 }).lean();
  accCache = { at: Date.now(), org: String(org), map: new Map(list.map((a) => [String(a._id), a.name])) };
  return accCache.map;
}

async function loadAll(org) {
  const list = await ShopifyOrder.find({ organization: org, orderDate: { $gte: START }, paymentMode: { $in: ["cod", "partial"] } }, FIELDS).lean();
  const names = await accountNames(org);
  const rows = [];
  for (const o of list) {
    const stage = stageOf(o);
    const amount = amountOf(o);
    if (!stage || !(amount > 0)) continue;
    rows.push({
      _id: o._id,
      name: o.name,
      orderDate: o.orderDate,
      deliveredAt: stage === "delivered" ? o.deliveredAt || o.statusChangedAt : null,
      status: o.status,
      stage,
      paymentMode: o.paymentMode,
      amount,
      total: o.total,
      customer: o.shippingAddress?.name || o.customerName || "",
      city: o.shippingAddress?.city || "",
      courier: o.shipment?.courierName || o.shipment?.carrier || "",
      account: (o.shipment?.account && names.get(String(o.shipment.account))) || o.shipment?.carrier || "—",
      awb: o.shipment?.awb || "",
      awbs: awbsOf(o),
      remit: o.codRemit || null,
    });
  }
  return rows;
}

function applyFilters(rows, q) {
  const from = q.from && /^\d{4}-\d{2}-\d{2}$/.test(q.from) ? q.from : "";
  const to = q.to && /^\d{4}-\d{2}-\d{2}$/.test(q.to) ? q.to : "";
  const by = q.dateBy === "delivered" ? "deliveredAt" : "orderDate";
  const term = up(q.q).replace(/^#/, "");
  return rows.filter((r) => {
    if (q.stage && q.stage !== "all" && r.stage !== q.stage) return false;
    const received = !!r.remit;
    if ((q.remit || "pending") === "pending" && received) return false;
    if (q.remit === "received" && !received) return false;
    if (q.account && r.account !== q.account) return false;
    if (q.courier && r.courier !== q.courier) return false;
    const d = ymd(r[by]);
    if (from && (!d || d < from)) return false;
    if (to && (!d || d > to)) return false;
    if (term && !(up(r.name).replace(/^#/, "") === term || r.awbs.some((a) => a.includes(term)) || up(r.customer).includes(term))) return false;
    return true;
  });
}

function summarize(rows) {
  const by = {};
  for (const r of rows) {
    const s = (by[r.account] = by[r.account] || { account: r.account, delivered: 0, deliveredCount: 0, inTransit: 0, inTransitCount: 0, received: 0, receivedCount: 0 });
    if (r.remit) {
      s.received = round2(s.received + (r.remit.amount ?? r.amount));
      s.receivedCount++;
    } else if (r.stage === "delivered") {
      s.delivered = round2(s.delivered + r.amount);
      s.deliveredCount++;
    } else {
      s.inTransit = round2(s.inTransit + r.amount);
      s.inTransitCount++;
    }
  }
  const list = Object.values(by).sort((a, b) => b.delivered - a.delivered);
  const total = list.reduce(
    (t, s) => ({ delivered: round2(t.delivered + s.delivered), deliveredCount: t.deliveredCount + s.deliveredCount, inTransit: round2(t.inTransit + s.inTransit), inTransitCount: t.inTransitCount + s.inTransitCount, received: round2(t.received + s.received), receivedCount: t.receivedCount + s.receivedCount }),
    { delivered: 0, deliveredCount: 0, inTransit: 0, inTransitCount: 0, received: 0, receivedCount: 0 },
  );
  return { byAccount: list, total };
}

async function report(org, q) {
  const all = await loadAll(org);
  const rows = applyFilters(all, q).sort((a, b) => new Date(a.deliveredAt || a.orderDate) - new Date(b.deliveredAt || b.orderDate));
  // Summary over the same filters except "received / pending", so the cards show pending and received together.
  const forSummary = applyFilters(all, { ...q, remit: "all" });
  return {
    rows,
    summary: summarize(forSummary),
    accounts: [...new Set(all.map((r) => r.account))].sort(),
    couriers: [...new Set(all.map((r) => r.courier).filter(Boolean))].sort(),
    since: "2026-04-01",
  };
}

async function markReceived(org, user, { ids, date, ref, undo }) {
  const at = date ? new Date(`${date}T12:00:00+05:30`) : new Date();
  let n = 0;
  for (const id of ids) {
    const o = await ShopifyOrder.findOne({ _id: id, organization: org }, FIELDS);
    if (!o) continue;
    if (undo) o.codRemit = undefined;
    else {
      if (o.codRemit) continue;
      o.codRemit = { at, ref: String(ref || "").slice(0, 100), amount: amountOf(o), by: user?._id, byName: user?.name || "", via: "manual", markedAt: new Date() };
    }
    o.markModified("codRemit");
    await o.save();
    n++;
  }
  return { done: n };
}

// A courier's remittance file (CSV / Excel): AWB column + amount column (+ date / UTR if present).
async function importRemittance(org, user, buffer, fileName) {
  const wb = XLSX.read(buffer, { type: "buffer", cellDates: true });
  let rows = [];
  for (const n of wb.SheetNames) {
    const r = XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: false, defval: "" });
    if (r.length > rows.length) rows = r;
  }
  const hi = rows.findIndex((r) => r.some((c) => /awb|waybill|airway|tracking|docket|cn\s*no|consignment/i.test(String(c))));
  if (hi === -1) throw new Error("No AWB column found — the file needs a column named AWB / Waybill / Tracking number");
  const h = rows[hi].map((c) => String(c).toLowerCase().trim());
  const col = (re, not) => h.findIndex((c) => re.test(c) && !(not && not.test(c)));
  const cAwb = col(/awb|waybill|airway|tracking|docket|cn\s*no|consignment/);
  const cAmt = col(/cod.*(amount|amt|value)|remit.*(amount|amt)|collect|amount|amt|value/, /charge|freight|fee|deduct|weight/);
  const cDate = col(/remit.*date|payment date|utr date|date/);
  const cRef = col(/utr|remittance\s*(id|no|number|ref)|reference|crf|batch/);
  const all = await loadAll(org);
  const byAwb = new Map();
  for (const r of all) for (const a of r.awbs) byAwb.set(a, r);
  const seen = new Set();
  const out = { marked: 0, already: 0, notFound: [], amountDiff: [] };
  for (const r of rows.slice(hi + 1)) {
    const awb = up(r[cAwb]).replace(/[^A-Z0-9]/g, "");
    if (!awb || seen.has(awb)) continue;
    seen.add(awb);
    const o = byAwb.get(awb);
    if (!o) {
      out.notFound.push(awb);
      continue;
    }
    if (o.remit) {
      out.already++;
      continue;
    }
    const amt = cAmt >= 0 ? Number(String(r[cAmt]).replace(/[^0-9.-]/g, "")) || null : null;
    const d = cDate >= 0 && r[cDate] ? new Date(r[cDate]) : null;
    if (amt !== null && Math.abs(amt - o.amount) > 1) out.amountDiff.push({ order: o.name, awb, expected: o.amount, paid: amt });
    await ShopifyOrder.updateOne(
      { _id: o._id, organization: org },
      { $set: { codRemit: { at: d && !isNaN(d) ? d : new Date(), ref: String((cRef >= 0 && r[cRef]) || fileName || "").slice(0, 100), amount: amt ?? o.amount, by: user?._id, byName: user?.name || "", via: "import", markedAt: new Date() } } },
    );
    o.remit = true;
    out.marked++;
  }
  out.notFound = out.notFound.slice(0, 200);
  return out;
}

function toExcel(rep, q) {
  const head = ["Order", "Order date", "Delivered on", "Status", "Payment", "Courier account", "Courier", "AWB", "Customer", "City", "Order total", "COD / balance due", "Received on", "Reference", "Received amount"];
  const body = rep.rows.map((r) => [
    r.name,
    ymd(r.orderDate),
    ymd(r.deliveredAt),
    r.stage === "delivered" ? (r.status === "delivered" ? "Delivered" : "Delivered, then returned") : "In transit",
    r.paymentMode === "partial" ? "Part-paid" : "COD",
    r.account,
    r.courier,
    r.awbs.join(", "),
    r.customer,
    r.city,
    r.total,
    r.amount,
    r.remit ? ymd(r.remit.at) : "",
    r.remit?.ref || "",
    r.remit ? r.remit.amount ?? r.amount : "",
  ]);
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([[`COD pending report — orders from 1 Apr 2026${q.from ? `, ${q.dateBy === "delivered" ? "delivered" : "ordered"} ${q.from} to ${q.to || "today"}` : ""}`], [], head, ...body]);
  ws["!cols"] = head.map((h, i) => ({ wch: [12, 11, 12, 18, 9, 18, 18, 16, 20, 14, 11, 14, 11, 18, 12][i] }));
  XLSX.utils.book_append_sheet(wb, ws, "Orders");
  const s = rep.summary;
  const sum = [["Courier account", "Delivered, pending (₹)", "Orders", "In transit (₹)", "Orders", "Received (₹)", "Orders"], ...s.byAccount.map((a) => [a.account, a.delivered, a.deliveredCount, a.inTransit, a.inTransitCount, a.received, a.receivedCount]), ["Total", s.total.delivered, s.total.deliveredCount, s.total.inTransit, s.total.inTransitCount, s.total.received, s.total.receivedCount]];
  const ws2 = XLSX.utils.aoa_to_sheet(sum);
  ws2["!cols"] = [{ wch: 22 }, { wch: 20 }, { wch: 8 }, { wch: 16 }, { wch: 8 }, { wch: 14 }, { wch: 8 }];
  XLSX.utils.book_append_sheet(wb, ws2, "By courier");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}

module.exports = { report, markReceived, importRemittance, toExcel, START };
