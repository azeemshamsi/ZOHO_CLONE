// Minimal .zip reader (stored / deflated entries), enough for report downloads such as Amazon's zipped CSVs.
const pako = require("pako");

function readZip(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  // End of central directory: scan back for its signature.
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) {
    if (b.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("Not a zip file");
  const count = b.readUInt16LE(eocd + 10);
  let p = b.readUInt32LE(eocd + 16);
  const out = [];
  for (let n = 0; n < count; n++) {
    if (b.readUInt32LE(p) !== 0x02014b50) throw new Error("Damaged zip file");
    const method = b.readUInt16LE(p + 10);
    const size = b.readUInt32LE(p + 20);
    const nameLen = b.readUInt16LE(p + 28);
    const extraLen = b.readUInt16LE(p + 30);
    const commentLen = b.readUInt16LE(p + 32);
    const local = b.readUInt32LE(p + 42);
    const name = b.slice(p + 46, p + 46 + nameLen).toString("utf8");
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith("/")) continue;
    const lNameLen = b.readUInt16LE(local + 26);
    const lExtraLen = b.readUInt16LE(local + 28);
    const start = local + 30 + lNameLen + lExtraLen;
    const raw = b.slice(start, start + size);
    let data;
    if (method === 0) data = raw;
    else if (method === 8) data = Buffer.from(pako.inflateRaw(raw));
    else throw new Error(`Unsupported compression in ${name}`);
    out.push({ name: name.split("/").pop(), data });
  }
  return out;
}

const isZip = (buf) => buf && buf.length > 4 && buf.readUInt32LE(0) === 0x04034b50;

module.exports = { readZip, isZip };
