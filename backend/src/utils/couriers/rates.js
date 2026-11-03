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

/* ---------------- rate card (same format and maths as the Maganova/BillFlow calculator) ---------------- */
// acc.rateCard = { enabled, rate_type: "slab"|"per_kg", volumetric_divisor, default_zone,
//   zones: [{ zone, slabs: [{ up_to_kg, price }], additional_per_kg, per_kg_rate }],
//   extras: { fuel_surcharge_pct, docket_charge, ecc_charge, ecc_slabs, owsp_slabs, ecc_districts: [{state, district}],
//             ras_states, ras_per_kg, gst_pct, cod_flat, cod_pct, idc_pct, efss_pct, fov_pct,
//             custom1_label, custom1_type: fixed|pct_freight|pct_value, custom1_value, custom2_… } }
// Pincode lists (zone / edl / ecc) are in CourierPincode.
const num = (v) => Number(v) || 0;

function volumetricWeight(l, w, h, divisor) {
  if (divisor <= 0 || l * w * h <= 0) return 0;
  return (l * w * h) / divisor;
}

// Chargeable weight: the higher of dead and volumetric, rounded UP to a whole kg.
function chargeableWeight(q, rc = {}) {
  const divisor = num(rc.volumetric_divisor) || 5000;
  const volumetric = volumetricWeight(num(q.length), num(q.breadth), num(q.height), divisor);
  return { weight: Math.ceil(Math.max(num(q.weight), volumetric)), volumetric: r2(volumetric), divisor };
}

// rate_type per_kg → weight × per_kg_rate. slab → the lowest of: each slab's price (weight within it)
// or its price + excess kg × additional_per_kg.
function slabFreight(cw, zoneRate, rateType) {
  if (rateType === "per_kg") return cw * num(zoneRate.per_kg_rate);
  const slabs = [...(zoneRate.slabs || [])].sort((a, b) => num(a.up_to_kg) - num(b.up_to_kg));
  if (!slabs.length) return 0;
  const add = num(zoneRate.additional_per_kg);
  return Math.min(...slabs.map((s) => (cw <= num(s.up_to_kg) ? num(s.price) : num(s.price) + (cw - num(s.up_to_kg)) * add)));
}

const nrm = (s) => String(s || "").split(/\s+/).filter(Boolean).join(" ").toLowerCase();
const stripAlias = (n) => (n.includes("(") && n.includes(")") ? n.split("(")[0].trim() : n.trim());
const extractAlias = (n) => (n.includes("(") && n.includes(")") ? n.split("(").slice(1).join("(").split(")")[0].trim() : "");
const slabPrice = (slabs, cw) => {
  const sorted = [...slabs].sort((a, b) => num(a.up_to_kg) - num(b.up_to_kg));
  const hit = sorted.find((s) => cw <= num(s.up_to_kg));
  return num((hit || sorted[sorted.length - 1]).price);
};

/**
 * The charge for one shipment from a rate card (pure; lookups already done).
 * ctx: { zone, cw, orderValue, isCod, destState, destDistrict, eccListed, eccListConfigured }
 */
function computeRateCard(rc, ctx) {
  const zoneRate = (rc.zones || []).find((z) => z.zone === ctx.zone);
  if (!zoneRate) return { error: `No rate set for zone '${ctx.zone}'` };
  const cw = ctx.cw;
  const x = rc.extras || {};
  const freight = slabFreight(cw, zoneRate, rc.rate_type || "slab");
  const fuel = (freight * num(x.fuel_surcharge_pct)) / 100;
  const docket = num(x.docket_charge);

  // ECC: destination district in the courier's list (or the pincode in its ECC list)
  let ecc = 0;
  let eccMatched = false;
  const eccDistricts = x.ecc_districts || [];
  if (eccDistricts.length && ctx.destDistrict) {
    const d = nrm(ctx.destDistrict);
    const st = nrm(ctx.destState);
    eccMatched = eccDistricts.some((e) => {
      const ed = e.district || "";
      const alias = nrm(extractAlias(ed));
      if (d !== nrm(stripAlias(ed)) && !(alias && d === alias)) return false;
      const es = nrm(e.state);
      return !es || st === es;
    });
  }
  if (!eccMatched && ctx.eccListConfigured) eccMatched = !!ctx.eccListed;
  if (eccMatched) ecc = (x.ecc_slabs || []).length ? slabPrice(x.ecc_slabs, cw) : num(x.ecc_charge);
  else if (!(eccDistricts.length || ctx.eccListConfigured)) ecc = num(x.ecc_charge); // nothing set up → flat fee

  // OWSP: over-weight surcharge slabs, on every shipment
  const owsp = (x.owsp_slabs || []).length ? slabPrice(x.owsp_slabs, cw) : 0;

  // RAS: per kg for chosen destination states
  let ras = 0;
  const rasStates = (x.ras_states || []).filter((s) => typeof s === "string");
  if (num(x.ras_per_kg) > 0 && rasStates.length && ctx.destState && rasStates.map(nrm).includes(nrm(ctx.destState))) ras = num(x.ras_per_kg) * cw;

  const value = num(ctx.orderValue);
  const idc = (freight * num(x.idc_pct)) / 100;
  const efss = (freight * num(x.efss_pct)) / 100;
  const fov = (value * num(x.fov_pct)) / 100;
  const custom = (t, v) => {
    v = num(v);
    if (v <= 0) return 0;
    if (t === "pct_freight") return (freight * v) / 100;
    if (t === "pct_value") return (value * v) / 100;
    return v;
  };
  const custom1 = custom(x.custom1_type || "fixed", x.custom1_value);
  const custom2 = custom(x.custom2_type || "fixed", x.custom2_value);
  const cod = ctx.isCod ? Math.max(num(x.cod_flat), (value * num(x.cod_pct)) / 100) : 0;

  const taxable = freight + fuel + docket + ecc + owsp + ras + idc + efss + fov + custom1 + custom2 + cod;
  const gst = (taxable * (x.gst_pct === undefined || x.gst_pct === "" || x.gst_pct === null ? 18 : num(x.gst_pct))) / 100;
  return {
    zone: ctx.zone,
    chargeableWeight: cw,
    breakdown: {
      freight: r2(freight),
      fuel_surcharge: r2(fuel),
      docket: r2(docket),
      ecc: r2(ecc),
      owsp: r2(owsp),
      ras: r2(ras),
      idc: r2(idc),
      efss: r2(efss),
      fov: r2(fov),
      custom1: custom1 > 0 ? { label: x.custom1_label || "Custom 1", amount: r2(custom1) } : null,
      custom2: custom2 > 0 ? { label: x.custom2_label || "Custom 2", amount: r2(custom2) } : null,
      cod_charge: r2(cod),
      gst: r2(gst),
    },
    total: r2(taxable + gst),
  };
}

const rateCardOn = (acc) => !!acc.rateCard?.enabled && Array.isArray(acc.rateCard.zones) && acc.rateCard.zones.length > 0;

// Pincode → state and district, cached.
async function locatePincode(pincode) {
  const PincodeLookup = require("../../models/PincodeLookup");
  if (!/^\d{6}$/.test(pincode || "")) return {};
  const hit = await PincodeLookup.findOne({ pincode }).lean();
  if (hit) return { state: hit.state, district: hit.district };
  let state = null;
  let district = null;
  try {
    const { data } = await request(`https://api.postalpincode.in/pincode/${pincode}`, { timeout: 10000 });
    const e = Array.isArray(data) ? data[0] : data?.["0"] || {};
    const po = e?.PostOffice?.[0];
    if (e?.Status === "Success" && po) [state, district] = [(po.State || "").trim() || null, (po.District || "").trim() || null];
  } catch {}
  await PincodeLookup.updateOne({ pincode }, { pincode, state, district, at: new Date() }, { upsert: true }).catch(() => {});
  return { state, district };
}

// Count / find in a courier's pincode lists (zone, edl, ecc).
async function listInfo(acc, kind, pincode) {
  const CourierPincode = require("../../models/CourierPincode");
  const configured = !!(await CourierPincode.exists({ account: acc._id, kind }));
  if (!configured) return { configured: false };
  const row = await CourierPincode.findOne({ account: acc._id, kind, pincode }).lean();
  return { configured: true, row };
}

// The rate card quote, with the zone from the courier's pincode list (or its default zone).
async function rateCardQuote(acc, q, cw) {
  const rc = acc.rateCard;
  const zl = await listInfo(acc, "zone", q.to);
  let zone;
  if (!zl.configured) {
    zone = rc.default_zone;
    if (!zone) return { error: "No pincode list uploaded and no default zone set" };
  } else {
    if (!zl.row) return { notListed: true, error: `${q.to} isn't in ${acc.name}'s pincode list` };
    zone = zl.row.zone;
  }
  const [loc, ecc] = await Promise.all([locatePincode(q.to), listInfo(acc, "ecc", q.to)]);
  const r = computeRateCard(rc, { zone, cw, orderValue: q.value, isCod: q.cod, destState: loc.state, destDistrict: loc.district, eccListed: !!ecc.row, eccListConfigured: ecc.configured });
  return { ...r, listed: zl.configured, destState: loc.state, destDistrict: loc.district };
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
      const md = /express/i.test(acc.options?.shippingMode || "") ? "E" : "S";
      const r = await request(`${c.base(acc)}/api/kinko/v1/invoice/charges/.json?${qs({ md, ss: "Delivered", d_pin: q.to, o_pin: q.from, cgm: Math.round(q.cw * 1000), pt: q.cod ? "COD" : "Pre-paid", cod: q.cod ? q.codAmount : undefined, l: q.length > 0 ? Math.round(q.length) : undefined, b: q.breadth > 0 ? Math.round(q.breadth) : undefined, h: q.height > 0 ? Math.round(q.height) : undefined })}`, { headers: c.h(acc), timeout: 12000 }).catch(() => null);
      const row = Array.isArray(r?.data) ? r.data[0] : r?.data && typeof r.data === "object" ? r.data : null;
      const total = Number(row?.total_amount || row?.gross_amount || 0);
      if (total > 0) {
        out.charge = r2(total);
        const gross = Number(row.gross_amount || 0);
        out.breakdown = { freight: r2(gross), cod_charge: r2(row.cod_charges || 0), gst: r2(row.tax_value ?? total - gross) };
        out.zone = String(row.zone || "");
      }
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
  // Chargeable weight with this courier's volumetric divisor, rounded up to a whole kg.
  const cwt = chargeableWeight(q, acc.rateCard || {});
  q.cw = cwt.weight;
  const out = { account: String(acc._id), name: acc.name, carrier: acc.carrier, test: !!acc.test, isDefault: !!acc.isDefault, serviceable: null, charge: null, source: "", etd: "", note: "", chargeableWeight: cwt.weight, volumetricWeight: cwt.volumetric };
  if (!/^\d{6}$/.test(q.to || "")) return { ...out, serviceable: false, note: "The order has no valid 6-digit pincode" };
  if (s.cod && acc.options?.codEnabled === false) return { ...out, serviceable: false, note: `${acc.name} is set up for prepaid only` };
  try {
    const r = await withTimeout(QUOTES[acc.carrier](acc, q), 15000);
    Object.assign(out, { serviceable: r.serviceable ?? null, etd: r.etd || "", note: r.note || "", courierName: r.courierName, courierId: r.courierId, options: r.options });
    if (r.charge > 0) Object.assign(out, { charge: r.charge, source: "api", breakdown: r.breakdown, zone: r.zone });
  } catch (e) {
    out.note = `Couldn't check: ${e.message}`;
    out.checkFailed = true;
  }
  if (rateCardOn(acc)) {
    try {
      if (out.charge == null && out.serviceable !== false) {
        const r = await rateCardQuote(acc, q, q.cw);
        if (r.notListed) {
          // Not in the courier's pincode list: not serviceable, unless its API says it is.
          if (out.serviceable !== true) Object.assign(out, { serviceable: false, note: r.error });
          else out.note = [out.note, r.error].filter(Boolean).join(" · ");
        } else if (r.error) out.note = [out.note, r.error].filter(Boolean).join(" · ");
        else {
          Object.assign(out, { charge: r.total, source: "rate card", breakdown: r.breakdown, zone: r.zone, destState: r.destState, destDistrict: r.destDistrict });
          if (out.serviceable === null && r.listed) out.serviceable = true; // in the courier's pincode list
        }
      }
      // EDL: in the courier's out-of-delivery-area list
      const edl = await listInfo(acc, "edl", q.to);
      out.edl = !!edl.row;
    } catch (e) {
      out.note = [out.note, `Rate card: ${e.message}`].filter(Boolean).join(" · ");
    }
  }
  return out;
}

// Serviceable first, cheapest first; couriers that can't deliver at the end.
function sortQuotes(rows) {
  const rank = (r) => (r.serviceable === false ? 2 : r.serviceable === null ? 1 : 0);
  return rows.sort((a, b) => rank(a) - rank(b) || (a.charge ?? 1e12) - (b.charge ?? 1e12) || a.name.localeCompare(b.name));
}

module.exports = { quoteAccount, sortQuotes, computeRateCard, slabFreight, chargeableWeight, volumetricWeight, rateCardOn, locatePincode };
