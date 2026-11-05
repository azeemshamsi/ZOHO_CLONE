// Send an order's shipping label: the courier's (stored PDF or link) or, failing that / when asked, OrdexaGo's own.
const CourierAccount = require("../../models/CourierAccount");
const Organization = require("../../models/Organization");
const { CARRIERS } = require("../couriers");
const { labelsPdf } = require("../couriers/label");

async function sendLabel(res, o, { org, storeOrg, own = false }) {
  if (!own) {
    if (o.shipment.labelPdf?.length) {
      res.setHeader("Content-Type", "application/pdf");
      return res.send(o.shipment.labelPdf);
    }
    const acc = o.shipment.account ? await CourierAccount.findById(o.shipment.account) : null;
    if (acc) {
      try {
        const l = await CARRIERS[acc.carrier].label(acc, o.shipment);
        if (l?.url) return res.send({ url: l.url });
        if (l?.pdf) {
          res.setHeader("Content-Type", "application/pdf");
          return res.send(l.pdf);
        }
      } catch {}
    }
    if (o.shipment.labelUrl) return res.send({ url: o.shipment.labelUrl });
  }
  const orgDoc = await Organization.findById(org);
  const accs = new Map((await CourierAccount.find({ organization: storeOrg })).map((a) => [String(a._id), a]));
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="label-${String(o.name).replace("#", "")}.pdf"`);
  res.send(await labelsPdf([o], orgDoc, accs));
}

module.exports = { sendLabel };
