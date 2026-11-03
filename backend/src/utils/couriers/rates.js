/**
 * Pincode serviceability and expected courier charges.
 * Each courier's API is asked first (live serviceability, and the rate where the API has one).
 * When the API gives no rate, the courier's manual rate card is used.
 *
 * Quote input q: { from, to, weight (kg), length, breadth, height (cm), cod, codAmount, value }
 * Result: { serviceable: true | false | null (couldn't check), charge, source: "api" | "rate card", etd, note, options[] }
 */
const { request, short } = require("./http");
const { CARRIERS } = require("./index");

const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const qs = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== "")).toString();
const yes = (v) => (v === undefined || v === null || v === "" ? null : /^(y|yes|true|1)$/i.test(String(v)));

/* ---------------- rate card ---------------- */
// Zones as Indian couriers usually price them.
const ZONES = [
  ["local", "Within city"],
  ["state", "Within state"],
  ["metro", "Metro to metro"],
  ["roi", "Rest of India"],
  ["special", "North-East, J&K, islands"],
];
const SPECIAL_STATES = ["01", "38", "11", "12", "13", "14", "15", "16", "17", "18", "35", "31"];
const METROS = ["delhi", "new delhi", "mumbai", "navi mumbai", "kolkata", "chennai", "bengaluru", "bangalore", "hyderabad", "ahmedabad", "pune", "secunderabad", "noida", "gurgaon", "gurugram", "thane"];
const norm = (s) => String(s || "").trim().toLowerCase();

function zoneOf(from, to) {
  if (SPECIAL_STATES.includes(to.state) || SPECIAL_STATES.includes(from.state)) return "special";
  if ((from.city && norm(from.city) === norm(to.city)) || (from.pincode && to.pincode && from.pincode.slice(0, 3) === to.pincode.slice(0, 3))) return "local";
  if (from.state && from.state === to.state) return "state";
  if (METROS.includes(norm(from.city)) && METROS.includes(norm(to.city))) return "metro";
  return "roi";
}

const rateCardOn = (acc) => !!acc.rateCard?.enabled && ZONES.some(([z]) => Number(acc.rateCard.zones?.[z]?.first) > 0);

// Chargeable weight: the higher of actual and volumetric, rounded up to the slab.
function chargeableWeight(q, rc = {}) {
  const divisor = Number(rc.divisor) || 5000;
  const vol = (Number(q.length) * Number(q.breadth) * Number(q.height)) / divisor || 0;
  const w = Math.max(Number(q.weight) || 0, vol);
  const slab = Number(rc.slab) || 0.5;
  return { weight: r2(Math.max(slab, Math.ceil(r2(w / slab)) * slab)), volumetric: r2(vol), slab };
}

function rateCardCharge(acc, q, from, to) {
  const rc = acc.rateCard || {};
  const zone = zoneOf(from, to);
  const z = rc.zones?.[zone] || {};
  const first = Number(z.first) || 0;
  if (!first) return null;
  const { weight, volumetric, slab } = chargeableWeight(q, rc);
  const extraSlabs = Math.max(0, Math.round((weight - slab) / slab));
  const freight = r2(first + extraSlabs * (Number(z.extra) || 0));
  const fuel = r2((freight * (Number(rc.fuelPercent) || 0)) / 100);
  const cod = q.cod ? r2(Math.max(Number(rc.codFixed) || 0, ((Number(q.codAmount) || 0) * (Number(rc.codPercent) || 0)) / 100)) : 0;
  const before = r2(freight + fuel + cod);
  const gst = r2((before * (rc.gstPercent === undefined || rc.gstPercent === "" ? 18 : Number(rc.gstPercent))) / 100);
  return { total: r2(before + gst), zone, zoneName: ZONES.find(([k]) => k === zone)[1], weight, volumetric, freight, fuel, cod, gst };
}

/* ---------------- courier APIs ---------------- */
const QUOTES = {
  async shiprocket(acc, q) {
    const c = CARRIERS.shiprocket;
    if (!q.from) return { serviceable: null, note: "Add the pickup pincode to this courier (Store Settings → Couriers) to check rates" };
    const { status, data } = await c.call(acc, `/courier/serviceability/?${qs({ pickup_postcode: q.from, delivery_postcode: q.to, weight: q.weight, cod: q.cod ? 1 : 0, declared_value: q.value, length: q.length, breadth: q.breadth, height: q.height })}`);
    const list = data.data?.available_courier_companies || [];
    if (!list.length) {
      if (status === 404 || data.status === 404 || /not serviceable|no courier/i.test(data.message || "")) return { serviceable: false, note: data.message || "No courier serves this pincode" };
      throw new Error(data.message || `Shiprocket rate check failed (${status})`);
    }
    const options = list
      .map((x) => ({ courierId: String(x.courier_company_id), name: x.courier_name, charge: r2(x.rate ?? x.freight_charge), etd: x.etd || (x.estimated_delivery_days ? `${x.estimated_delivery_days} days` : "") }))
      .filter((o) => o.charge > 0)
      .sort((a, b) => a.charge - b.charge);
    const want = acc.options?.courierId ? String(acc.options.courierId) : String(data.data?.recommended_courier_company_id || data.data?.shiprocket_recommended_courier_id || "");
    if (acc.options?.courierId && !options.some((o) => o.courierId === want)) return { serviceable: false, note: `Your chosen Shiprocket courier (ID ${want}) doesn't serve this pincode`, options };
    const pick = options.find((o) => o.courierId === want) || options[0];
    return { serviceable: true, charge: pick?.charge, etd: pick?.etd, courierName: pick?.name, courierId: pick?.courierId, options: options.slice(0, 8) };
  },

  async delhivery(acc, q) {
    const c = CARRIERS.delhivery;
    if (!acc.credentials?.token) return { serviceable: null, note: "Add the API token" };
    const { data } = await request(`${c.base(acc)}/c/api/pin-codes/json/?filter_codes=${q.to}`, { headers: c.h(acc), timeout: 12000 });
    if (!Array.isArray(data.delivery_codes)) throw new Error(data.detail || data.error || "Delhivery pincode check failed");
    const pc = data.delivery_codes[0]?.postal_code;
    if (!pc) return { serviceable: false, note: `Delhivery doesn't deliver to ${q.to}` };
    if (/embargo/i.test(pc.remarks || "")) return { serviceable: false, note: `Delhivery: ${q.to} is under embargo` };
    if (q.cod && yes(pc.cod) === false && yes(pc.cash) !== true) return { serviceable: false, note: `Delhivery: no COD to ${q.to}` };
    if (!q.cod && yes(pc.pre_paid) === false) return { serviceable: false, note: `Delhivery: no prepaid delivery to ${q.to}` };
    const out = { serviceable: true };
    if (q.from) {
      const grams = Math.round(chargeableWeight(q, { slab: 0.001 }).weight * 1000);
      const md = /express/i.test(acc.options?.shippingMode || "") ? "E" : "S";
      const r = await request(`${c.base(acc)}/api/kinko/v1/invoice/charges/.json?${qs({ md, ss: "Delivered", d_pin: q.to, o_pin: q.from, cgm: grams, pt: q.cod ? "COD" : "Pre-paid", cod: q.cod ? q.codAmount : 0 })}`, { headers: c.h(acc), timeout: 12000 }).catch(() => null);
      const row = Array.isArray(r?.data) ? r.data[0] : r?.data?.[0] || null;
      if (row && Number(row.total_amount) > 0) out.charge = r2(row.total_amount);
    }
    return out;
  },

  async bluedart(acc, q) {
    const c = CARRIERS.bluedart;
    if (!acc.credentials?.loginId || !acc.credentials?.licenceKey || !acc.credentials?.clientId) return { serviceable: null, note: "Add the Blue Dart credentials" };
    const tok = await c.token(acc);
    const { data } = await request(`${c.base(acc)}/finder/v1/GetServicesforPincode`, { method: "POST", headers: { JWTToken: tok }, json: { pinCode: q.to, profile: c.profile(acc) }, timeout: 12000 });
    const r = data.GetServicesforPincodeResult || data;
    if (r.IsError) {
      if (/invalid|not.*servic|no record/i.test(r.ErrorMessage || "")) return { serviceable: false, note: `Blue Dart: ${r.ErrorMessage}` };
      throw new Error(r.ErrorMessage || short(data));
    }
    const surface = (acc.options?.productCode || "A") === "E";
    const key = `eTail${q.cod ? "COD" : "PrePaid"}${surface ? "Ground" : "Air"}Inbound`;
    let ok = yes(r[key]);
    if (ok === null) ok = yes(surface ? r.GroundInbound : r.ApexInbound);
    return ok === false ? { serviceable: false, note: `Blue Dart: no ${q.cod ? "COD" : "prepaid"} ${surface ? "surface" : "air"} service to ${q.to}` } : { serviceable: ok };
  },

  async dtdc(acc, q) {
    if (!q.from) return { serviceable: null, note: "Add the pickup pincode to check serviceability" };
    const url = acc.options?.pincodeUrl || "https://smarttrack.ctbsplus.dtdc.com/ratecalapi/PincodeApiCall";
    const { status, data } = await request(url, { method: "POST", json: { orgPincode: q.from, desPincode: q.to }, timeout: 12000 });
    const z = data.ZIPCODE_RESP?.[0];
    if (!z) throw new Error(`DTDC pincode check failed (${status})`);
    const flag = yes(z.SERVFLAG);
    if (flag === false) return { serviceable: false, note: z.MESSAGE && !/success/i.test(z.MESSAGE) ? `DTDC: ${z.MESSAGE}` : `DTDC doesn't deliver to ${q.to}` };
    return { serviceable: flag };
  },

  async shadowfax(acc, q) {
    const c = CARRIERS.shadowfax;
    if (!acc.credentials?.token) return { serviceable: null, note: "Add the API token" };
    const { status, data } = await request(`${c.base(acc)}/api/v1/serviceability/?${qs({ service: "customer_delivery", pincodes: q.to, page: 1, count: 10 })}`, { headers: c.h(acc), timeout: 12000 });
    if (status >= 400) throw new Error(data.message || `Shadowfax pincode check failed (${status})`);
    const list = data.Serviceability || data.serviceability || data.data || data.results;
    if (!Array.isArray(list)) throw new Error("Shadowfax pincode check gave an unexpected answer");
    const hit = list.find((x) => String(x.code || x.pincode) === String(q.to));
    return hit ? { serviceable: true } : { serviceable: false, note: `Shadowfax doesn't deliver to ${q.to}` };
  },

  async custom(acc, q) {
    const pins = String(acc.options?.pincodes || "").split(/[\s,;]+/).filter(Boolean);
    if (!pins.length) return { serviceable: null };
    return pins.includes(q.to) ? { serviceable: true } : { serviceable: false, note: `${acc.name} doesn't deliver to ${q.to}` };
  },
};

const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("The courier didn't answer in time")), ms))]);

// One courier: live check, then the rate card for the charge if the API had none.
async function quoteAccount(acc, s) {
  const p = acc.pickup || {};
  const q = { from: p.pincode || "", to: s.consignee.pincode, weight: s.weight, length: s.length, breadth: s.breadth, height: s.height, cod: s.cod, codAmount: s.codAmount, value: s.value };
  const out = { account: String(acc._id), name: acc.name, carrier: acc.carrier, test: !!acc.test, isDefault: !!acc.isDefault, serviceable: null, charge: null, source: "", etd: "", note: "" };
  if (!/^\d{6}$/.test(q.to || "")) return { ...out, serviceable: false, note: "The order has no valid 6-digit pincode" };
  if (s.cod && acc.options?.codEnabled === false) return { ...out, serviceable: false, note: `${acc.name} is set up for prepaid only` };
  try {
    const r = await withTimeout(QUOTES[acc.carrier](acc, q), 15000);
    Object.assign(out, { serviceable: r.serviceable ?? null, etd: r.etd || "", note: r.note || "", courierName: r.courierName, courierId: r.courierId, options: r.options });
    if (r.charge > 0) Object.assign(out, { charge: r.charge, source: "api" });
  } catch (e) {
    out.note = `Couldn't check: ${e.message}`;
    out.checkFailed = true;
  }
  if (out.charge == null && out.serviceable !== false && rateCardOn(acc)) {
    const rc = rateCardCharge(acc, q, { pincode: p.pincode, city: p.city, state: p.state }, { pincode: q.to, city: s.consignee.city, state: s.consignee.state });
    if (rc) Object.assign(out, { charge: rc.total, source: "rate card", breakdown: rc });
  }
  return out;
}

// Serviceable first, cheapest first; couriers that can't deliver at the end.
function sortQuotes(rows) {
  const rank = (r) => (r.serviceable === false ? 2 : r.serviceable === null ? 1 : 0);
  return rows.sort((a, b) => rank(a) - rank(b) || (a.charge ?? 1e12) - (b.charge ?? 1e12) || a.name.localeCompare(b.name));
}

module.exports = { quoteAccount, sortQuotes, rateCardCharge, chargeableWeight, zoneOf, ZONES, rateCardOn };
