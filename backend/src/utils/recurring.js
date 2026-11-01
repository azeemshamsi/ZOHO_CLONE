/**
 * Recurring profiles: work out each occurrence date and create the documents that are due.
 * Runs when the server starts, every hour, and whenever someone opens a recurring list.
 */
const RecurringProfile = require("../models/RecurringProfile");
const { istToday } = require("./time");
const { round2 } = require("./http");

const iso = (d) => new Date(d).toISOString().slice(0, 10);

// The n-th occurrence (0 = start date). Months/years keep the start day, clamped to month end.
function occurrence(p, n) {
  const s = new Date(p.startDate);
  const step = n * (p.every || 1);
  if (p.unit === "day" || p.unit === "week") return new Date(s.getTime() + step * (p.unit === "week" ? 7 : 1) * 86400000);
  const months = p.unit === "year" ? step * 12 : step;
  const y = s.getUTCFullYear();
  const m = s.getUTCMonth() + months;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(s.getUTCDate(), last)));
}

function refreshNext(p) {
  p.nextDate = occurrence(p, p.occurrences);
  if (p.endDate && p.nextDate > new Date(p.endDate) && p.status === "active") p.status = "expired";
  if (p.status === "expired" && (!p.endDate || p.nextDate <= new Date(p.endDate))) p.status = "active";
}

// Create one document for date `d`.
async function createOne(p, d) {
  const req = { org: p.organization };
  const t = { ...p.template };
  const date = iso(d);
  const due = iso(new Date(d.getTime() + (p.paymentTerms || 0) * 86400000));
  if (p.kind === "invoice") {
    const doc = await require("../routes/invoices").createInvoice(req, { ...t, date, dueDate: due, status: p.createAs === "draft" ? "draft" : "sent" });
    return { id: doc._id, number: doc.invoiceNumber, total: doc.total };
  }
  if (p.kind === "bill") {
    const billNumber = `${t.billNumber || "RB"}-${date.replace(/-/g, "")}`;
    const doc = await require("../routes/bills").createBill(req, { ...t, billNumber, date, dueDate: due, status: p.createAs === "draft" ? "draft" : "open" });
    return { id: doc._id, number: doc.billNumber, total: doc.total };
  }
  const doc = await require("../routes/expenses").createExpense(req, { ...t, date });
  return { id: doc._id, number: doc.reference || doc.category, total: doc.total };
}

// Create everything due up to today for one profile.
async function runProfile(p) {
  if (p.status !== "active") return 0;
  const today = istToday();
  let made = 0;
  for (let guard = 0; guard < 400; guard++) {
    const d = occurrence(p, p.occurrences);
    if (d > today) break;
    if (p.endDate && d > new Date(p.endDate)) break;
    try {
      const r = await createOne(p, d);
      p.history.push({ ...r, date: d });
      p.occurrences += 1;
      p.lastError = "";
      made++;
    } catch (e) {
      p.lastError = `${iso(d)}: ${e.message}`;
      break;
    }
  }
  refreshNext(p);
  await p.save();
  return made;
}

async function runDue(organization) {
  const q = { status: "active" };
  if (organization) q.organization = organization;
  const due = await RecurringProfile.find({ ...q, nextDate: { $lte: istToday() } });
  let made = 0;
  for (const p of due) made += await runProfile(p);
  return made;
}

function startScheduler() {
  const tick = () => {
    runDue().catch((e) => console.error("Recurring run failed:", e.message));
    require("./reminders").runReminders().catch((e) => console.error("Reminders failed:", e.message));
    require("./fx").autoRefresh().catch((e) => console.error("Exchange rates failed:", e.message));
  };
  setTimeout(tick, 5000);
  setInterval(tick, 60 * 60 * 1000).unref();
  // Shopify: new orders every 15 minutes, courier tracking every 2 hours.
  const shopify = () => require("./shopify/sync").autoSyncAll().catch((e) => console.error("Shopify sync failed:", e.message));
  setTimeout(shopify, 20000);
  setInterval(shopify, 15 * 60 * 1000).unref();
  setInterval(() => require("./shopify/inventory").pushAll().catch((e) => console.error("Inventory sync failed:", e.message)), 30 * 60 * 1000).unref();
  setInterval(() => require("./shopify/ship").trackAll().catch((e) => console.error("Courier tracking failed:", e.message)), 2 * 60 * 60 * 1000).unref();
}

module.exports = { occurrence, refreshNext, runProfile, runDue, startScheduler, round2 };
