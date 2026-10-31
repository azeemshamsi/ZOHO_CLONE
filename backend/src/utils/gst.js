const { round2 } = require("./http");

/**
 * Compute line amounts and GST for an invoice.
 * Intra-state supply (business state == place of supply): tax split equally into CGST + SGST.
 * Inter-state supply: whole tax is IGST.
 */
function computeTotals({ lineItems = [], orgState, placeOfSupply, shippingCharge = 0, adjustment = 0 }) {
  const isInterState = Boolean(placeOfSupply) && Boolean(orgState) && placeOfSupply !== orgState;
  let subTotal = 0;
  let cgst = 0;
  let sgst = 0;
  let igst = 0;

  const lines = lineItems.map((li) => {
    const quantity = Number(li.quantity) || 0;
    const rate = Number(li.rate) || 0;
    const discount = Math.min(Math.max(Number(li.discount) || 0, 0), 100);
    const taxRate = Number(li.taxRate) || 0;
    const amount = round2(quantity * rate * (1 - discount / 100));
    const tax = (amount * taxRate) / 100;
    const line = { ...li, quantity, rate, discount, taxRate, amount, cgst: 0, sgst: 0, igst: 0 };
    if (isInterState) {
      line.igst = round2(tax);
    } else {
      line.cgst = round2(tax / 2);
      line.sgst = round2(tax / 2);
    }
    subTotal += amount;
    cgst += line.cgst;
    sgst += line.sgst;
    igst += line.igst;
    return line;
  });

  subTotal = round2(subTotal);
  cgst = round2(cgst);
  sgst = round2(sgst);
  igst = round2(igst);
  const taxTotal = round2(cgst + sgst + igst);
  const total = round2(subTotal + taxTotal + (Number(shippingCharge) || 0) + (Number(adjustment) || 0));

  return { lineItems: lines, isInterState, subTotal, cgst, sgst, igst, taxTotal, total };
}

module.exports = { computeTotals };
