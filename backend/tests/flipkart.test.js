const test = require("node:test");
const assert = require("node:assert");
const { normalise } = require("../src/utils/flipkart/orders");

test("Flipkart shipment → order: lines, totals, state, self-ship", () => {
  const s = {
    shipmentId: "SH1",
    locationId: "LOC1",
    dispatchByDate: "2026-11-12T10:00:00Z",
    orderItems: [
      { orderItemId: "OI1", orderId: "OD100", sku: "AFR1", fsn: "FSN1234567890", quantity: 2, status: "APPROVED", orderDate: "2026-11-10T05:00:00Z", paymentType: "COD", priceComponents: { sellingPrice: 1900, totalPrice: 2000, shippingCharge: 100 } },
      { orderItemId: "OI2", orderId: "OD100", sku: "AFR2", quantity: 1, status: "CANCELLED", priceComponents: { totalPrice: 500 } },
    ],
    shipmentType: "SELF_SHIP",
  };
  const n = normalise(s, { deliveryAddress: { firstName: "Asha", lastName: "K", addressLine1: "12 MG Road", city: "Pune", stateName: "Maharashtra", pincode: 411001, contactNumber: "9999999999" } }, { _id: "acc" });
  assert.equal(n.name, "OD100");
  assert.equal(n.lines.length, 1);
  assert.equal(n.lines[0].unitPrice, 950);
  assert.equal(n.total, 2000);
  assert.equal(n.paymentMode, "cod");
  assert.equal(n.flipkart.state, "APPROVED");
  assert.equal(n.flipkart.selfShip, true);
  assert.equal(n.shippingAddress.zip, "411001");
  assert.equal(n.customer.name, "Asha K");
});

test("Flipkart sales report → documents: sale, return, cash back", () => {
  const { plan } = require("../src/utils/import/flipkart");
  const base = { "Seller GSTIN": "09ADVFS0745G1ZL", "Order ID": "OD1", "Order Item ID": "1", "Product Title/Description": '"""Cake Stand"""', SKU: '"""SKU:AFR1"""', "HSN Code": "44209090", "Item Quantity": "1.0", "IGST Rate": "5.0", "Customer's Delivery State": "Bihar", "Customer's Billing State": "Bihar", "Business GST Number": "NA", "Order Type": "Prepaid", "Fulfilment Type": "NON_FBF" };
  const sales = [
    { ...base, "Event Type": "Sale", "Event Sub Type": "Sale", "Final Invoice Amount (Price after discount+Shipping Charges)": "105.0", "Taxable Value (Final Invoice Amount -Taxes)": "100.0", "IGST Amount": "5.0", "Total TCS Deducted": "0.5", "Buyer Invoice ID": "NUA1", "Buyer Invoice Date": "2026-10-11 00:00:00.0" },
    { ...base, "Event Type": "Return", "Event Sub Type": "Return", "Final Invoice Amount (Price after discount+Shipping Charges)": "105.0", "Taxable Value (Final Invoice Amount -Taxes)": "-100.0", "IGST Amount": "-5.0", "Total TCS Deducted": "-0.5", "Buyer Invoice ID": "MFA1", "Buyer Invoice Date": "2026-10-20 00:00:00.0" },
  ];
  const cashback = [{ "Seller GSTIN": "09ADVFS0745G1ZL", "Order ID": "OD1", "Order Item ID": "1", "Document Type": "Credit Note", "Document Sub Type": "Sale", "Credit Note ID/ Debit Note ID": "LYA1", "Invoice Amount": "4.2", "Invoice Date": "2026-10-11 00:00:00.0", "Taxable Value": "4.0", "IGST Rate": "5.0", "IGST Amount": "0.2", "Customer's Delivery State": "Bihar" }];
  const p = plan(sales, cashback, "09ADVFS0745G1ZL");
  assert.equal(p.invoices.length, 2);
  assert.equal(p.creditNotes.length, 1);
  const inv = p.invoices.find((d) => d.number === "NUA1");
  assert.equal(inv.lines[0].sku, "AFR1");
  assert.equal(inv.lines[0].name, "Cake Stand");
  assert.equal(inv.pos, "10");
  assert.equal(p.creditNotes[0].taxable, -100);
  assert.equal(p.creditNotes[0].amazon.value, -105);
  const cb = p.invoices.find((d) => d.number === "LYA1");
  assert.equal(cb.lines[0].kind, "cashback");
  assert.equal(cb.lines[0].hsn, "44209090");
  assert.equal(cb.taxable, 4);
});

test("Pepperfry GSTR-1 csv → invoices by order number, returns as PFCN credit notes", () => {
  const P = require("../src/utils/import/pepperfry");
  const head = "OrderID-SKU,State,GSTIN,Document Type,Taxability,Supply Type,GSTIN of Recipient,Recipient State,Name of the Recipient,Invoice Number,Invoice Date,Invoice Value,Total Discount,GSTIN of E-Comm Operator,Item Code,Category,HSN/SAC,Product/Service Description,Invoiced Quantity,Sale Price(Before discount),Merchant Discount,Taxable Value,Total GST Rate,IGST (%),IGST Amount,CSGT (%),CGST Amount,SGST/UTGST (%),SGST/UTGST Amount,Ship from (State),Ship to (State),Way Bill No,Credit Note No,Credit Note Date,Credit Note Amount,Taxable Value,Total GST Rate,IGST (%),IGST Amount,CSGT (%),CGST Amount,SGST/UTGST (%),SGST/UTGST Amount,TCS Amount";
  const row = "1-A-S-PM1,Uttar Pradesh,09ADVFS0745G1ZL,Invoice,Taxable,Inter-state,URD,Keralam,X,1,05/10/2026,1050,0,27AADCT9282F1Z0,A-S-PM1,G,4420,Shelf,1,1050,0,1000,5,5,50,0,0,0,0,Uttar Pradesh,Keralam,,,,0,0,0,5,0,0,0,0,0,5";
  const sales = { name: "GSTR-1_1_Uttar Pradesh.csv", data: Buffer.from(`${head}\n${row}\n`) };
  const refunds = { name: "GSTR-1_Refunds_1.csv", data: Buffer.from(`Return Date,Invoiced Qty,Return Qty,${head}\n2026-10-20 10:00:00,1,1.0000,${row}\n`) };
  const u = P.unpack([sales, refunds]);
  const p = P.plan(u, "09ADVFS0745G1ZL");
  assert.equal(p.invoices[0].number, "1");
  assert.equal(p.invoices[0].pos, "32");
  assert.equal(p.invoices[0].taxable, 1000);
  assert.equal(p.creditNotes[0].number, "PFCN1");
  assert.equal(p.creditNotes[0].taxable, -1000);
  assert.equal(p.creditNotes[0].amazon.value, -1050);
});
