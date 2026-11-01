// MGI's own shipping label: 4x6" thermal (one per page) or A4 (four per page).
const path = require("path");
const PDFDocument = require("pdfkit");
const bwipjs = require("bwip-js");
const { stateName, codOf } = require("./index");

const FONT = path.join(__dirname, "..", "..", "..", "assets", "fonts", "DejaVuSans.ttf");
const BOLD = path.join(__dirname, "..", "..", "..", "assets", "fonts", "DejaVuSans-Bold.ttf");
const money = (n) => `₹${Number(n || 0).toLocaleString("en-IN", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
const W4 = 288;
const H6 = 432;

const barcode = (text, height = 12) => bwipjs.toBuffer({ bcid: "code128", text: String(text), scale: 3, height, includetext: false });

async function drawLabel(doc, o, org, acc) {
  const sh = o.shipment || {};
  const a = o.shippingAddress || {};
  const p = acc?.pickup || {};
  const L = 12;
  const W = 264;
  const line = (y) => doc.moveTo(6, y).lineTo(282, y).stroke();
  doc.lineWidth(1.2).rect(6, 6, 276, 420).stroke();
  doc.lineWidth(0.8);
  // Seller + payment
  doc.font("b").fontSize(12).fillColor("#000").text(org.name, L, 16, { width: 170, height: 16, ellipsis: true });
  const cod = codOf(o);
  const payText = o.paymentMode === "prepaid" || !cod ? "PREPAID" : o.paymentMode === "partial" ? "PART COD" : "COD";
  doc.roundedRect(190, 12, 84, cod ? 32 : 22, 5).stroke();
  doc.font("b").fontSize(10).text(payText, 190, 17, { width: 84, align: "center" });
  if (cod) doc.font("b").fontSize(9).text(`Collect ${money(cod)}`, 190, 30, { width: 84, align: "center" });
  line(50);
  // AWB
  doc.font("r").fontSize(7.5).text("AWB NUMBER", L, 56);
  doc.font("b").fontSize(12).text(sh.awb || "", L, 66, { width: 160 });
  doc.font("b").fontSize(11).text((sh.courierName || acc?.name || "").toUpperCase(), 140, 56, { width: 134, align: "right" });
  if (sh.refs?.routing) doc.font("b").fontSize(10).text(`RC: ${sh.refs.routing}`, 140, 70, { width: 134, align: "right" });
  if (sh.awb) doc.image(await barcode(sh.awb, 12), 44, 86, { width: 200, height: 44 });
  line(136);
  // Deliver to
  doc.font("b").fontSize(8).text("DELIVER TO:", L, 142);
  doc.font("b").fontSize(11).text(a.name || o.customer?.name || "", L, 153, { width: W, height: 14, ellipsis: true });
  doc.font("r").fontSize(8.5);
  const addr = [a.address1, a.address2, a.company].filter(Boolean);
  for (const t of addr.slice(0, 3)) doc.text(t, L, doc.y, { width: W, height: 11, ellipsis: true });
  doc.text(`${a.city || ""}${a.city ? ", " : ""}${a.province || stateName(a.state)}, ${a.zip || ""}`, L, doc.y, { width: W });
  doc.font("b").text(`Ph: ${String(a.phone || o.customer?.phone || "").replace(/\D/g, "").slice(-10)}`, L, doc.y, { width: W });
  line(232);
  // Order
  const kv = (k, v, x, y) => {
    doc.font("r").fontSize(8).text(k, x, y);
    doc.font("b").fontSize(9).text(v, x + 52, y - 1, { width: 84, height: 11, ellipsis: true });
  };
  kv("ORDER NO:", o.name || "", L, 240);
  kv("DATE:", new Date(o.orderDate).toLocaleDateString("en-GB", { timeZone: "Asia/Kolkata" }).replace(/\//g, "-"), 146, 240);
  kv("WEIGHT:", sh.weight ? `${sh.weight} kg` : "", L, 255);
  kv("DIMS:", sh.length ? `${sh.length}x${sh.breadth}x${sh.height} cm` : "", 146, 255);
  if (o.invoiceNumber || o.paymentMode === "partial") {
    kv("INVOICE:", o.invoiceNumber || "", L, 270);
    kv("VALUE:", money(o.total), 146, 270);
  }
  line(286);
  // Products
  doc.font("b").fontSize(8).text("PRODUCTS", L, 291);
  let y = 302;
  const lines = o.lines.filter((x) => x.quantity > 0);
  for (const l of lines.slice(0, 4)) {
    doc.font("r").fontSize(7.5).text(`• ${l.variantTitle ? `${l.title} - ${l.variantTitle}` : l.title}`, L, y, { width: 150, height: 10, ellipsis: true });
    doc.text(l.sku ? `SKU: ${l.sku}` : "", 165, y, { width: 75, height: 10, ellipsis: true });
    doc.text(`Qty: ${l.quantity}`, 240, y, { width: 34, align: "right" });
    y += 11;
  }
  if (lines.length > 4) doc.font("r").fontSize(7.5).text(`+ ${lines.length - 4} more item(s)`, L, y);
  line(350);
  // Return address
  doc.font("b").fontSize(8).text("FROM (Return Address):", L, 355);
  doc.font("b").fontSize(9).text(p.name || org.name, L, 366, { width: W });
  doc.font("r").fontSize(7.5).text([p.address || org.address?.street, `${p.city || org.address?.city || ""}, ${stateName(p.state || org.state)}, ${p.pincode || org.address?.pincode || ""}`, `Ph: ${p.phone || org.phone || ""}${org.gstin ? `   GSTIN: ${org.gstin}` : ""}`].filter(Boolean).join("\n"), L, doc.y, { width: W });
  if (acc?.options?.customText) doc.font("b").fontSize(7.5).text(String(acc.options.customText).slice(0, 150), L, 410, { width: W, align: "center", height: 12, ellipsis: true });
}

async function labelsPdf(orders, org, accounts = new Map(), format) {
  const first = orders[0]?.shipment?.account ? accounts.get(String(orders[0].shipment.account)) : null;
  const a4 = (format || first?.options?.labelFormat) === "a4";
  const doc = new PDFDocument({ size: a4 ? "A4" : [W4, H6], margin: 0, autoFirstPage: false });
  doc.registerFont("r", FONT);
  doc.registerFont("b", BOLD);
  const chunks = [];
  doc.on("data", (c) => chunks.push(c));
  const done = new Promise((res, rej) => {
    doc.on("end", () => res(Buffer.concat(chunks)));
    doc.on("error", rej);
  });
  // A4: 2 x 2 labels, scaled to fit with margins.
  const k = 0.95;
  const slots = [
    [12, 12],
    [12 + W4 * k + 7, 12],
    [12, 12 + H6 * k + 7],
    [12 + W4 * k + 7, 12 + H6 * k + 7],
  ];
  for (const [i, o] of orders.entries()) {
    const acc = o.shipment?.account ? accounts.get(String(o.shipment.account)) : null;
    if (!a4) {
      doc.addPage();
      await drawLabel(doc, o, org, acc);
      continue;
    }
    if (i % 4 === 0) doc.addPage();
    const [x, y] = slots[i % 4];
    doc.save();
    doc.translate(x, y).scale(k);
    await drawLabel(doc, o, org, acc);
    doc.restore();
  }
  if (!orders.length) doc.addPage();
  doc.end();
  return done;
}

module.exports = { labelsPdf };
