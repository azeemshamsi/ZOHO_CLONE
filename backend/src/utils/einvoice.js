/**
 * GST e-invoice (IRP schema INV-01, version 1.1) and e-way bill (bulk upload 1.0.0421) JSON,
 * with the checks the portals apply, so files upload without rejections.
 */
const { round2 } = require("./http");

const r2 = (n) => round2(Number(n) || 0);
const dmy = (d) => {
  const x = new Date(d);
  return `${String(x.getUTCDate()).padStart(2, "0")}/${String(x.getUTCMonth() + 1).padStart(2, "0")}/${x.getUTCFullYear()}`;
};
const pin = (p) => (/^[1-9][0-9]{5}$/.test(String(p || "").trim()) ? Number(String(p).trim()) : null);
const GSTIN_RX = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;

// Unit → GST Unit Quantity Code (UQC).
const UQC = {
  pcs: "PCS", pc: "PCS", piece: "PCS", pieces: "PCS", nos: "NOS", no: "NOS", number: "NOS", unit: "UNT", units: "UNT", set: "SET", sets: "SET", pair: "PRS", pairs: "PRS",
  kg: "KGS", kgs: "KGS", g: "GMS", gm: "GMS", gms: "GMS", gram: "GMS", ton: "TON", tonne: "TON", mt: "MTS", quintal: "QTL", qtl: "QTL",
  l: "LTR", ltr: "LTR", litre: "LTR", liter: "LTR", ml: "MLT", m: "MTR", mtr: "MTR", metre: "MTR", meter: "MTR", cm: "CMS", km: "KME", ft: "FTS", feet: "FTS", inch: "INC",
  sqft: "SQF", "sq ft": "SQF", sqm: "SQM", "sq m": "SQM", cbm: "CBM", box: "BOX", boxes: "BOX", bag: "BAG", bags: "BAG", bundle: "BDL", roll: "ROL", rolls: "ROL",
  doz: "DOZ", dozen: "DOZ", pkt: "PAC", packet: "PAC", pack: "PAC", bottle: "BTL", btl: "BTL", can: "CAN", carton: "CTN", ctn: "CTN", drum: "DRM", tube: "TUB", tablets: "TBS",
  hrs: "OTH", hr: "OTH", hour: "OTH", hours: "OTH", day: "OTH", days: "OTH", month: "OTH", job: "OTH", lot: "OTH",
};
const uqc = (u) => UQC[String(u || "").trim().toLowerCase()] || (String(u || "").length === 3 ? String(u).toUpperCase() : "OTH");
const isService = (hsn) => String(hsn || "").startsWith("99");

// Seller details: the branch (if any) overrides the organization.
async function seller(org, doc) {
  let s = { gstin: org.gstin, name: org.name, address: org.address || {}, phone: org.phone, email: org.email };
  if (doc.branch) {
    const b = await require("../models/Branch").findById(doc.branch).lean();
    if (b) s = { gstin: b.gstin || org.gstin, name: org.name, address: b.address || {}, phone: b.phone || org.phone, email: b.email || org.email };
  }
  return s;
}

function supplyType(customer, doc) {
  const t = customer?.gstTreatment;
  const taxed = r2(doc.taxTotal) > 0;
  if (t === "sez") return taxed ? "SEZWP" : "SEZWOP";
  if (t === "overseas") return taxed ? "EXPWP" : "EXPWOP";
  return "B2B";
}

// Is an e-invoice needed? Only for registered (B2B), SEZ and export customers.
const needsEInvoice = (customer) => ["registered", "sez", "overseas"].includes(customer?.gstTreatment);

/** Build one e-invoice JSON. kind: "invoice" | "creditNote". Returns { json, errors }. */
async function buildEInvoice(org, doc, kind) {
  const errors = [];
  const customer = await require("../models/Customer").findById(doc.customer).lean();
  const s = await seller(org, doc);
  const rate = Number(doc.exchangeRate) || 1; // e-invoice values are always in ₹
  const inr = (n) => r2(n * rate);
  const sup = supplyType(customer, doc);
  const exp = sup.startsWith("EXP");
  const number = kind === "invoice" ? doc.invoiceNumber : doc.number;

  if (!needsEInvoice(customer)) errors.push("E-invoices are only for registered, SEZ and export customers (this customer is B2C)");
  if (!s.gstin || !GSTIN_RX.test(s.gstin)) errors.push("Your GSTIN is missing or invalid (Settings, or the branch)");
  if (!/^[A-Za-z1-9][A-Za-z0-9/-]{0,15}$/.test(number || "")) errors.push(`Document number "${number}" must be 1–16 characters (letters, digits, / and -) and can't start with 0`);
  const sa = s.address || {};
  if (!sa.street || sa.street.trim().length < 3) errors.push("Your address line is missing (at least 3 characters)");
  if (!sa.city || sa.city.trim().length < 3) errors.push("Your city is missing");
  if (!pin(sa.pincode)) errors.push("Your PIN code is missing or invalid");
  const ba = doc.billingAddress || customer?.billingAddress || {};
  if (!exp) {
    if (!doc.customerGstin || !GSTIN_RX.test(doc.customerGstin)) errors.push("Customer GSTIN is missing or invalid");
    if (!ba.street || ba.street.trim().length < 3) errors.push("Customer address line is missing");
    if (!ba.city || ba.city.trim().length < 3) errors.push("Customer city is missing");
    if (!pin(ba.pincode)) errors.push("Customer PIN code is missing or invalid");
  }

  const items = (doc.lineItems || []).map((l, i) => {
    const hsn = String(l.hsnSac || "").replace(/\s/g, "");
    if (!/^[0-9]{4}([0-9]{2}){0,2}$/.test(hsn)) errors.push(`Line ${i + 1} (${l.name}): HSN/SAC must be 4, 6 or 8 digits`);
    const tot = inr(l.quantity * l.rate);
    const ass = inr(l.amount);
    return {
      SlNo: String(i + 1),
      PrdDesc: String(l.name || "").slice(0, 300),
      IsServc: isService(hsn) ? "Y" : "N",
      HsnCd: hsn,
      Qty: Number(l.quantity),
      Unit: uqc(l.unit),
      UnitPrice: r2(l.rate * rate),
      TotAmt: tot,
      Discount: r2(Math.max(0, tot - ass)),
      AssAmt: ass,
      GstRt: Number(l.taxRate) || 0,
      IgstAmt: inr(l.igst),
      CgstAmt: inr(l.cgst),
      SgstAmt: inr(l.sgst),
      CesRt: 0,
      CesAmt: 0,
      TotItemVal: r2(ass + inr(l.igst) + inr(l.cgst) + inr(l.sgst)),
    };
  });
  if (!items.length) errors.push("The document has no items");

  const val = {
    AssVal: r2(items.reduce((t, x) => t + x.AssAmt, 0)),
    CgstVal: r2(items.reduce((t, x) => t + x.CgstAmt, 0)),
    SgstVal: r2(items.reduce((t, x) => t + x.SgstAmt, 0)),
    IgstVal: r2(items.reduce((t, x) => t + x.IgstAmt, 0)),
    CesVal: 0,
    OthChrg: inr(doc.shippingCharge),
    RndOffAmt: inr(doc.adjustment),
    TotInvVal: inr(doc.total),
  };
  const sumVal = r2(val.AssVal + val.CgstVal + val.SgstVal + val.IgstVal + val.OthChrg + val.RndOffAmt);
  if (Math.abs(sumVal - val.TotInvVal) > 1) errors.push(`Totals don't add up (₹${sumVal} vs ₹${val.TotInvVal})`);
  if (Math.abs(val.RndOffAmt) > 10) errors.push("Rounding adjustment can't be more than ₹10 on an e-invoice");

  const json = {
    Version: "1.1",
    TranDtls: { TaxSch: "GST", SupTyp: sup, RegRev: "N", IgstOnIntra: "N" },
    DocDtls: { Typ: kind === "creditNote" ? "CRN" : "INV", No: number, Dt: dmy(doc.date) },
    SellerDtls: {
      Gstin: s.gstin,
      LglNm: s.name,
      Addr1: (sa.street || "").slice(0, 100),
      Loc: (sa.city || "").slice(0, 50),
      Pin: pin(sa.pincode),
      Stcd: String(s.gstin || "").slice(0, 2),
      ...(s.phone ? { Ph: String(s.phone).replace(/\D/g, "").slice(-12) } : {}),
      ...(s.email ? { Em: s.email } : {}),
    },
    BuyerDtls: exp
      ? { Gstin: "URP", LglNm: doc.customerName, Pos: "96", Addr1: (ba.street || "Overseas").slice(0, 100), Loc: (ba.city || "Overseas").slice(0, 50), Pin: 999999, Stcd: "96" }
      : { Gstin: doc.customerGstin, LglNm: doc.customerName, Pos: doc.placeOfSupply, Addr1: (ba.street || "").slice(0, 100), Loc: (ba.city || "").slice(0, 50), Pin: pin(ba.pincode), Stcd: String(doc.customerGstin || "").slice(0, 2) },
    ItemList: items,
    ValDtls: val,
  };
  if (exp) json.ExpDtls = { ...(doc.currency && doc.currency !== "INR" ? { ForCur: doc.currency } : {}), CntCode: (ba.countryCode || "").toUpperCase() || undefined };
  if (kind === "creditNote" && doc.invoice) {
    const inv = await require("../models/Invoice").findById(doc.invoice).lean();
    if (inv) json.RefDtls = { PrecDocDtls: [{ InvNo: inv.invoiceNumber, InvDt: dmy(inv.date) }] };
  }
  return { json, errors, supplyType: sup };
}

/** E-way bill (bulk upload) for an invoice with transport details in doc.eway. */
async function buildEwayBill(org, doc) {
  const errors = [];
  const t = doc.eway || {};
  const customer = await require("../models/Customer").findById(doc.customer).lean();
  const s = await seller(org, doc);
  const rate = Number(doc.exchangeRate) || 1;
  const inr = (n) => r2(n * rate);
  const sa = s.address || {};
  const ship = t.shipTo && (t.shipTo.pincode || t.shipTo.city) ? t.shipTo : doc.billingAddress || customer?.billingAddress || {};
  const goods = (doc.lineItems || []).filter((l) => !isService(l.hsnSac));
  if (!goods.length) errors.push("E-way bills are for goods; every line here is a service (SAC 99…)");
  if (!s.gstin || !GSTIN_RX.test(s.gstin)) errors.push("Your GSTIN is missing or invalid");
  if (!pin(sa.pincode)) errors.push("Your PIN code is missing or invalid");
  if (!pin(ship.pincode)) errors.push("Delivery PIN code is missing or invalid");
  const distance = Number(t.distance) || 0;
  if (!(distance > 0 && distance <= 4000)) errors.push("Approximate distance (km) is required, up to 4000");
  const mode = String(t.transMode || "1");
  if (mode === "1" && !t.vehicleNo && !t.transporterId) errors.push("Enter the vehicle number, or a transporter ID to let the transporter fill Part B");
  if (t.vehicleNo && !/^[A-Z]{2}[0-9]{1,2}[A-Z]{0,3}[0-9]{4}$|^TM[0-9A-Z]{6}$/.test(t.vehicleNo.replace(/[\s-]/g, "").toUpperCase())) errors.push("Vehicle number looks wrong (e.g. MH12AB1234)");
  if (t.transporterId && !GSTIN_RX.test(t.transporterId) && !/^[0-9]{2}[A-Z0-9]{13}$/.test(t.transporterId)) errors.push("Transporter ID must be a 15-character GSTIN/TRANSIN");
  if (["2", "3", "4"].includes(mode) && !t.transDocNo) errors.push("Rail, air and ship need the transport document number");
  goods.forEach((l, i) => {
    if (!/^[0-9]{4,8}$/.test(String(l.hsnSac || ""))) errors.push(`Line ${i + 1} (${l.name}): HSN code is required`);
  });
  const taxable = r2(goods.reduce((x, l) => x + inr(l.amount), 0));
  const toGstin = customer?.gstTreatment === "registered" || customer?.gstTreatment === "sez" ? doc.customerGstin : "URP";
  const exp = customer?.gstTreatment === "overseas";
  const bill = {
    userGstin: s.gstin,
    supplyType: "O",
    subSupplyType: exp ? 3 : 1, // 1 supply, 3 export
    subSupplyDesc: "",
    docType: "INV",
    docNo: doc.invoiceNumber,
    docDate: dmy(doc.date),
    fromGstin: s.gstin,
    fromTrdName: s.name,
    fromAddr1: (sa.street || "").slice(0, 120),
    fromAddr2: "",
    fromPlace: (sa.city || "").slice(0, 50),
    fromPincode: pin(sa.pincode),
    fromStateCode: Number(String(s.gstin || "").slice(0, 2)),
    actFromStateCode: Number(String(s.gstin || "").slice(0, 2)),
    toGstin: exp ? "URP" : toGstin || "URP",
    toTrdName: doc.customerName,
    toAddr1: (ship.street || "").slice(0, 120),
    toAddr2: "",
    toPlace: (ship.city || "").slice(0, 50),
    toPincode: exp ? 999999 : pin(ship.pincode),
    toStateCode: exp ? 99 : Number(doc.placeOfSupply),
    actToStateCode: exp ? 99 : Number(ship.state || doc.placeOfSupply),
    transactionType: 1,
    totalValue: taxable,
    cgstValue: r2(goods.reduce((x, l) => x + inr(l.cgst), 0)),
    sgstValue: r2(goods.reduce((x, l) => x + inr(l.sgst), 0)),
    igstValue: r2(goods.reduce((x, l) => x + inr(l.igst), 0)),
    cessValue: 0,
    cessNonAdvolValue: 0,
    totInvValue: inr(doc.total),
    otherValue: 0,
    transMode: Number(mode),
    transDistance: String(distance),
    transporterName: t.transporterName || "",
    transporterId: (t.transporterId || "").toUpperCase(),
    transDocNo: t.transDocNo || "",
    transDocDate: t.transDocDate ? dmy(t.transDocDate) : "",
    vehicleNo: (t.vehicleNo || "").replace(/[\s-]/g, "").toUpperCase(),
    vehicleType: t.vehicleType === "O" ? "O" : "R",
    itemList: goods.map((l, i) => ({
      itemNo: i + 1,
      productName: String(l.name).slice(0, 100),
      productDesc: String(l.description || l.name).slice(0, 100),
      hsnCode: Number(l.hsnSac),
      quantity: Number(l.quantity),
      qtyUnit: uqc(l.unit),
      taxableAmount: inr(l.amount),
      sgstRate: l.sgst ? Number(l.taxRate) / 2 : 0,
      cgstRate: l.cgst ? Number(l.taxRate) / 2 : 0,
      igstRate: l.igst ? Number(l.taxRate) : 0,
      cessRate: 0,
      cessNonadvol: 0,
    })),
  };
  // Everything that isn't goods taxable value or tax on goods (services, shipping, rounding) is "other value",
  // so total invoice value = taxable + taxes + other, as the portal checks.
  bill.otherValue = r2(bill.totInvValue - bill.totalValue - bill.cgstValue - bill.sgstValue - bill.igstValue);
  return { json: bill, errors, value: inr(doc.total) };
}

module.exports = { buildEInvoice, buildEwayBill, needsEInvoice, isService, uqc, dmy, EWB_THRESHOLD: 50000 };
