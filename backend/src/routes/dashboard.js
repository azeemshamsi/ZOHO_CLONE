const router = require("express").Router();
const Invoice = require("../models/Invoice");
const Payment = require("../models/Payment");
const Customer = require("../models/Customer");
const Item = require("../models/Item");
const { ah, round2 } = require("../utils/http");

const DAY = 24 * 60 * 60 * 1000;

// Indian financial year starts 1 April.
function fiscalYearStart(d = new Date()) {
  const y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
  return new Date(y, 3, 1);
}

router.get(
  "/",
  ah(async (req, res) => {
    const org = req.org;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const fyStart = fiscalYearStart(today);
    const monthsBack = new Date(today.getFullYear(), today.getMonth() - 11, 1);

    const [invoices, payments, customerCount, itemCount] = await Promise.all([
      Invoice.find(
        { organization: org, status: { $nin: ["draft", "void"] } },
        { lineItems: 0, billingAddress: 0 }
      ).lean(),
      Payment.find({ organization: org, date: { $gte: monthsBack } }, { amount: 1, date: 1 }).lean(),
      Customer.countDocuments({ organization: org }),
      Item.countDocuments({ organization: org }),
    ]);

    const recv = { total: 0, current: 0, overdue: 0, buckets: { "1-15": 0, "16-30": 0, "31-45": 0, "45+": 0 } };
    for (const inv of invoices) {
      if (inv.balance <= 0) continue;
      recv.total += inv.balance;
      const late = Math.floor((today - new Date(inv.dueDate)) / DAY);
      if (late <= 0) {
        recv.current += inv.balance;
      } else {
        recv.overdue += inv.balance;
        const key = late <= 15 ? "1-15" : late <= 30 ? "16-30" : late <= 45 ? "31-45" : "45+";
        recv.buckets[key] += inv.balance;
      }
    }
    recv.total = round2(recv.total);
    recv.current = round2(recv.current);
    recv.overdue = round2(recv.overdue);
    Object.keys(recv.buckets).forEach((k) => (recv.buckets[k] = round2(recv.buckets[k])));

    // Last 12 months: sales (invoiced) vs receipts.
    const months = [];
    for (let i = 0; i < 12; i++) {
      const d = new Date(monthsBack.getFullYear(), monthsBack.getMonth() + i, 1);
      months.push({ key: `${d.getFullYear()}-${d.getMonth()}`, label: d.toLocaleString("en-IN", { month: "short" }), year: d.getFullYear(), sales: 0, receipts: 0 });
    }
    const idx = Object.fromEntries(months.map((m, i) => [m.key, i]));
    let salesThisFy = 0;
    for (const inv of invoices) {
      const d = new Date(inv.date);
      const i = idx[`${d.getFullYear()}-${d.getMonth()}`];
      if (i !== undefined) months[i].sales += inv.total;
      if (d >= fyStart) salesThisFy += inv.total;
    }
    for (const p of payments) {
      const d = new Date(p.date);
      const i = idx[`${d.getFullYear()}-${d.getMonth()}`];
      if (i !== undefined) months[i].receipts += p.amount;
    }
    months.forEach((m) => {
      m.sales = round2(m.sales);
      m.receipts = round2(m.receipts);
    });

    // Top customers by receivable.
    const byCustomer = {};
    for (const inv of invoices) {
      if (inv.balance <= 0) continue;
      const k = String(inv.customer);
      byCustomer[k] = byCustomer[k] || { customer: inv.customer, name: inv.customerName, balance: 0 };
      byCustomer[k].balance = round2(byCustomer[k].balance + inv.balance);
    }
    const topDebtors = Object.values(byCustomer).sort((a, b) => b.balance - a.balance).slice(0, 5);

    const recentInvoices = await Invoice.find({ organization: org }, { lineItems: 0, billingAddress: 0 })
      .sort({ createdAt: -1 })
      .limit(6);

    res.send({
      receivables: recv,
      salesThisFy: round2(salesThisFy),
      fiscalYearStart: fyStart,
      receiptsThisFy: round2(payments.filter((p) => new Date(p.date) >= fyStart).reduce((s, p) => s + p.amount, 0)),
      months,
      topDebtors,
      recentInvoices,
      counts: { customers: customerCount, items: itemCount, invoices: invoices.length },
    });
  })
);

module.exports = router;
