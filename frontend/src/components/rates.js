// Text for a courier quote's charge breakdown (rate card or API).
const LABELS = [
  ["freight", "Freight"],
  ["fuel_surcharge", "Fuel"],
  ["docket", "Docket"],
  ["ecc", "ECC"],
  ["owsp", "OWSP"],
  ["ras", "RAS"],
  ["idc", "IDC"],
  ["efss", "EFSS"],
  ["fov", "FOV"],
  ["cod_charge", "COD"],
  ["gst", "GST"],
];
export function breakdownText(r) {
  const b = r?.breakdown;
  if (!b) return r?.source === "api" ? "From the courier's API" : "";
  const parts = LABELS.filter(([k]) => Number(b[k]) > 0).map(([k, l]) => `${l} ₹${b[k]}`);
  for (const c of [b.custom1, b.custom2]) if (c?.amount > 0) parts.splice(parts.length - 1, 0, `${c.label} ₹${c.amount}`);
  const head = [r.zone ? `Zone ${r.zone}` : "", r.chargeableWeight ? `${r.chargeableWeight} kg chargeable` : "", r.destDistrict ? `${r.destDistrict}, ${r.destState}` : ""].filter(Boolean).join(" · ");
  return [head, parts.join(" + ")].filter(Boolean).join("\n");
}
