// The package an order ships in: from its products' package types, a chosen package type, or typed in.
const PackageType = require("../../models/PackageType");
const Item = require("../../models/Item");

const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const dims = (p) => ({ weight: r2(p.weight), length: r2(p.length), breadth: r2(p.breadth), height: r2(p.height) });

// From the order's items. One package type for a single unit → that box; several → total weight,
// the largest length and breadth, stacked heights. null when any product has no package type.
async function packageFromItems(order, itemMap) {
  const lines = (order.lines || []).filter((l) => l.quantity > 0);
  if (!lines.length) return null;
  const map = itemMap || new Map((await Item.find({ _id: { $in: lines.map((l) => l.item).filter(Boolean) } }, { packageType: 1 }).lean()).map((i) => [String(i._id), i]));
  const ptIds = lines.map((l) => map.get(String(l.item))?.packageType).filter(Boolean);
  if (ptIds.length < lines.length) return null;
  const types = new Map((await PackageType.find({ _id: { $in: ptIds } }).lean()).map((p) => [String(p._id), p]));
  const parts = lines.map((l) => ({ pt: types.get(String(map.get(String(l.item)).packageType)), qty: l.quantity }));
  if (parts.some((x) => !x.pt)) return null;
  const units = parts.reduce((n, x) => n + x.qty, 0);
  if (units === 1) return { ...dims(parts[0].pt), packageType: String(parts[0].pt._id), packageName: parts[0].pt.name, source: "products" };
  return {
    weight: r2(parts.reduce((s, x) => s + x.pt.weight * x.qty, 0)),
    length: Math.max(...parts.map((x) => x.pt.length)),
    breadth: Math.max(...parts.map((x) => x.pt.breadth)),
    height: r2(parts.reduce((s, x) => s + x.pt.height * x.qty, 0)),
    packageName: parts.map((x) => `${x.qty} × ${x.pt.name}`).join(" + "),
    source: "products",
  };
}

// input: { packageType } | { weight, length, breadth, height } | {} (auto from the products)
async function resolvePackage(order, input = {}, org, itemMap) {
  if (input.packageType) {
    const pt = await PackageType.findOne({ _id: input.packageType, organization: org });
    if (!pt) throw new Error("Package type not found");
    return { ...dims(pt), packageType: String(pt._id), packageName: pt.name, source: "chosen" };
  }
  if (Number(input.weight) > 0) {
    const miss = ["length", "breadth", "height"].filter((k) => !(Number(input[k]) > 0));
    if (miss.length) throw new Error(`Enter the package ${miss.join(", ")}`);
    return { ...dims(input), packageName: "", source: "manual" };
  }
  return packageFromItems(order, itemMap);
}

module.exports = { resolvePackage, packageFromItems };
