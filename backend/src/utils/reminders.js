/**
 * Automatic payment reminders, sent by the hourly scheduler for organizations that turned them on
 * (Settings → Email → Payment reminders). Each configured day is sent once per invoice.
 */
const { money, fmtDate } = require("./pdf");

const DAY = 86400000;
const reminderBody = (d, org, name) => {
  const late = Math.max(0, Math.floor((require("./time").istToday() - new Date(d.dueDate)) / DAY));
  return `Dear ${name},\n\nThis is a friendly reminder that invoice ${d.invoiceNumber} for ${money(d.total)} was due on ${fmtDate(d.dueDate)}${late ? ` (${late} day${late === 1 ? "" : "s"} ago)` : ""}.\n\nBalance due: ${money(d.balance)}\n\nPlease arrange the payment at the earliest. If you've already paid, please ignore this email.\n\nRegards,\n${org.name}`;
};

async function runReminders() {
  const Organization = require("../models/Organization");
  const Invoice = require("../models/Invoice");
  const Customer = require("../models/Customer");
  const EmailLog = require("../models/EmailLog");
  const { canEmail, sendOrgMail } = require("./mailer");
  const { pdfFor, fileName, DOCS } = require("./documents");
  const today = require("./time").istToday();
  let sent = 0;
  const orgs = await Organization.find({ "reminders.enabled": true });
  for (const org of orgs) {
    if (!canEmail(org)) continue;
    const days = [...new Set(org.reminders.days || [])].filter((n) => n >= 0).sort((a, b) => a - b);
    if (!days.length) continue;
    const invoices = await Invoice.find({ organization: org._id, status: { $in: ["sent", "partially_paid"] }, balance: { $gt: 0 }, dueDate: { $lt: today } });
    for (const inv of invoices) {
      const late = Math.floor((today - new Date(inv.dueDate)) / DAY);
      // The latest reminder step that's due, but only if it became due in the last 3 days
      // (so switching reminders on doesn't email every old invoice at once).
      const step = days.filter((d) => d <= late && late - d <= 3).pop();
      if (step === undefined) continue;
      if (await EmailLog.exists({ docId: inv._id, type: "reminder", reminderDay: step })) continue;
      const c = await Customer.findById(inv.customer).lean();
      if (!c?.email) continue;
      try {
        const name = c.displayName || inv.customerName;
        await sendOrgMail(org, {
          to: [c.email],
          subject: `Payment reminder: Invoice ${inv.invoiceNumber} is overdue`,
          text: reminderBody(inv, org, name),
          attachments: [{ filename: fileName(DOCS.invoice, inv), content: await pdfFor(org, "invoice", inv) }],
        });
        await EmailLog.create({ organization: org._id, kind: "invoice", docId: inv._id, type: "reminder", reminderDay: step, to: [c.email], subject: `Payment reminder: Invoice ${inv.invoiceNumber} is overdue`, sentBy: "Automatic" });
        sent++;
      } catch (e) {
        console.error(`Reminder for ${inv.invoiceNumber} failed:`, e.message);
      }
    }
  }
  return sent;
}

module.exports = { runReminders, reminderBody };
