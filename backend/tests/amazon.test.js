const test = require("node:test");
const assert = require("node:assert");
const { parseCsv, plan } = require("../src/utils/import/amazon");

const HEAD = "Seller Gstin,Invoice Number,Invoice Date,Transaction Type,Order Id,Quantity,Item Description,Hsn/sac,Sku,Ship To State,Invoice Amount,Tax Exclusive Gross,Total Tax Amount,Cgst Rate,Sgst Rate,Utgst Rate,Igst Rate,Principal Amount Basis,Igst Tax,Cgst Tax,Sgst Tax,Shipping Amount Basis,Shipping Promo Discount Basis,Shipping Igst Tax,Shipping Promo Tax,Item Promo Discount Basis,Item Promo Tax,Credit Note No,Credit Note Date";
const csv = [
  HEAD,
  'G1,KNSF-1,2026-10-02 10:00:00,Shipment,O1,1,"Shelf, wooden",44219090,R1,MAHARASHTRA,1432,1363.81,68.19,0,0,0,0.05,1363.81,68.19,0,0,38.1,-38.1,1.9,-1.9,0,0,,',
  "G1,KNSF-1,2026-10-02 10:00:00,Refund,O1,1,Shelf,44219090,R1,MAHARASHTRA,-1432,-1363.81,-68.19,0,0,0,0.05,-1363.81,-68.19,0,0,0,0,0,0,0,0,KNSF-C-1,2026-10-09 10:00:00",
  "G1,,2026-10-03 10:00:00,Cancel,O2,1,Shelf,44219090,R1,DELHI,0,0,0,0,0,0,0.05,0,0,0,0,0,0,0,0,0,0,,",
  "G2,DEL5-1,2026-10-03 10:00:00,Shipment,O3,1,Shelf,44219090,R1,DELHI,500,476.19,23.81,0,0,0,0.05,476.19,23.81,0,0,0,0,0,0,0,0,,",
].join("\n");

test("MTR rows: invoice, refund as negative credit note, cancel and other GSTIN skipped", () => {
  const rows = parseCsv(csv);
  assert.equal(rows[0]["Item Description"], "Shelf, wooden");
  const p = plan(rows, "G1");
  assert.equal(p.invoices.length, 1);
  assert.equal(p.invoices[0].taxable, 1363.81); // shipping cancelled by its promotion
  assert.equal(p.invoices[0].lines.length, 1);
  assert.equal(p.invoices[0].pos, "27");
  assert.equal(p.creditNotes.length, 1);
  assert.equal(p.creditNotes[0].number, "KNSF-C-1");
  assert.equal(p.creditNotes[0].invoiceNumber, "KNSF-1");
  assert.equal(p.creditNotes[0].taxable, -1363.81);
  assert.equal(p.creditNotes[0].amazon.value, -1432);
  assert.equal(p.skipped.cancel, 1);
  assert.deepEqual(p.skipped.otherGstin, { G2: 1 });
});
