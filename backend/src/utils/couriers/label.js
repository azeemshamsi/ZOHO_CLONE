// MGI's own 4x6" shipping label (used for custom couriers and whenever a carrier gives no label).
const path = require("path");
const PDFDocument = require("pdfkit");
const bwipjs = require("bwip-js");
const { stateName } = require("./index");

const FONT = path.join(__dirname, "..", "..", "..", "assets", "fonts", "DejaVuSans.ttf");
const BOLD = path.join(__dirname, "..", "..", "..", "assets", "fonts", "DejaVuSans-Bold.ttf");
const money = (n) => `₹${Number(n || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

async function barcode(text, height = 12) {
  return bwipjs.toBuffer({ bcid: "code128", text: String(text), scale: 3, height, includetext: false });
}

async function labelsPdf(orders, org, accounts = new Map()) {
  const doc = new PDFDocument({ size: [288, 432], margin: 0, autoFirstPage: false });
  doc.registerFont("r", FONT);
  doc.registerFont("b", BOLD);
  const chunks = [];
  doc.on("data", (c) => chunks.push(c));
  const done = new Promise((res, rej) => {
    doc.on("end", () => res(Buffer.concat(chunks)));
    doc.on("error", rej);
  });
  for (const o of orders) {
    const sh = o.shipment || {};
    const a = o.shippingAddress || {};
    const acc = sh.account ? accounts.get(String(sh.account)) : null;
    const p = acc?.pickup || {};
    doc.addPage();
    const L = 12;
    const W = 264;
    doc.lineWidth(1).rect(6, 6, 276, 420).stroke();
    // Courier + AWB
    doc.font("b").fontSize(13).text(sh.courierName || acc?.name || "Courier", L, 14, { width: W * 0.6 });
    doc.font("b").fontSize(13).text(o.paymentMode === "cod" ? "COD" : "PREPAID", L, 14, { width: W, align: "right" });
    if (o.paymentMode === "cod") doc.font("b").fontSize(10).text(`Collect ${money(o.outstanding > 0 ? o.outstanding : o.total)}`, L, 30, { width: W, align: "right" });
    if (sh.awb) {
      doc.image(await barcode(sh.awb, 14), L + 12, 46, { width: W - 24, height: 50 });
      doc.font("b").fontSize(11).text(`AWB ${sh.awb}`, L, 100, { width: W, align: "center" });
    }
    doc.moveTo(6, 118).lineTo(282, 118).stroke();
    // Ship to
    doc.font("b").fontSize(8).text("SHIP TO", L, 124);
    doc.font("b").fontSize(11).text(a.name || o.customer?.name || "", L, 135, { width: W });
    doc.font("r").fontSize(9).text([a.address1, a.address2, `${a.city || ""}${a.city ? ", " : ""}${a.province || stateName(a.state)} ${a.zip || ""}`].filter(Boolean).join("\n"), { width: W });
    doc.font("b").fontSize(9).text(`Phone: ${a.phone || o.customer?.phone || ""}`, { width: W });
    doc.font("b").fontSize(18).text(a.zip || "", L, 222, { width: W, align: "right" });
    doc.moveTo(6, 246).lineTo(282, 246).stroke();
    // Order
    doc.font("b").fontSize(8).text("ORDER", L, 252);
    doc.font("b").fontSize(10).text(`${o.name}   ${new Date(o.orderDate).toLocaleDateString("en-IN")}`, L, 262);
    doc.image(await barcode(String(o.name).replace(/^#/, ""), 8), L + 150, 252, { width: 100, height: 22 });
    let y = 280;
    doc.font("r").fontSize(8);
    for (const l of o.lines.filter((x) => x.quantity > 0).slice(0, 6)) {
      doc.text(`${l.quantity} × ${(l.variantTitle ? `${l.title} - ${l.variantTitle}` : l.title).slice(0, 48)}${l.sku ? ` (${l.sku})` : ""}`, L, y, { width: W, lineBreak: false, ellipsis: true });
      y += 11;
    }
    const more = o.lines.filter((x) => x.quantity > 0).length - 6;
    if (more > 0) doc.text(`+ ${more} more`, L, y), (y += 11);
    doc.font("b").fontSize(8).text(`Value ${money(o.total)}${o.invoiceNumber ? `   Invoice ${o.invoiceNumber}` : ""}   ${sh.weight ? `${sh.weight} kg` : ""}`, L, Math.max(y + 2, 340), { width: W });
    doc.moveTo(6, 360).lineTo(282, 360).stroke();
    // Return address
    doc.font("b").fontSize(8).text("IF UNDELIVERED, RETURN TO", L, 366);
    doc.font("r").fontSize(8).text([p.name || org.name, p.address || [org.address?.street, org.address?.city].filter(Boolean).join(", "), `${p.city || org.address?.city || ""} ${stateName(p.state || org.state)} ${p.pincode || org.address?.pincode || ""}`, p.phone || org.phone ? `Phone: ${p.phone || org.phone}` : "", org.gstin ? `GSTIN: ${org.gstin}` : ""].filter(Boolean).join("\n"), L, 377, { width: W });
  }
  if (!orders.length) doc.addPage();
  doc.end();
  return done;
}

module.exports = { labelsPdf };
