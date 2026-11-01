/**
 * Courier integrations. Each carrier exposes:
 *   book(acc, s)      → { awb, courierName, labelUrl?, trackingUrl?, refs? }
 *   track(acc, sh)    → { status: picked|in_transit|out_for_delivery|delivered|rto|cancelled|pending, text, events[] }
 *   label(acc, sh)    → { url } | { pdf: Buffer } | null   (null → MGI prints its own 4x6 label)
 *   cancel(acc, sh)
 * `s` is the shipment built from a Shopify order (see shipmentFrom); `sh` is order.shipment.
 */
const { request, short } = require("./http");
const { STATES } = require("../states");

const stateName = (code) => STATES.find(([c]) => c === code)?.[1] || code || "";
const phone10 = (p) => String(p || "").replace(/\D/g, "").slice(-10);
const ymd = (d) => new Date(d.getTime() + 5.5 * 3600000).toISOString().slice(0, 10);
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const need = (acc, keys) => {
  const miss = keys.filter((k) => !acc.credentials?.[k]);
  if (miss.length) throw new Error(`${acc.name}: add ${miss.join(", ")} in Shopify Settings → Couriers`);
};
const need2 = (acc, keys) => {
  const miss = keys.filter((k) => !acc.options?.[k]);
  if (miss.length) throw new Error(`${acc.name}: add ${miss.join(", ")} in Shopify Settings → Couriers`);
};
const pickupOk = (acc) => {
  const p = acc.pickup || {};
  if (!p.pincode || !p.address || !p.phone) throw new Error(`${acc.name}: fill in the pickup address, pincode and phone in Shopify Settings → Couriers`);
};

// Map courier status text to MGI's tracking states.
function normStatus(text) {
  const t = String(text || "").toLowerCase();
  if (/rto|return(ed)? to origin|returned|return delivered|rt[- ]?(in|delivered)/.test(t)) return "rto";
  if (/cancel/.test(t)) return "cancelled";
  if (/^delivered|delivered$|\bdelivered\b/.test(t) && !/not delivered|undelivered/.test(t)) return "delivered";
  if (/out for delivery|ofd/.test(t)) return "out_for_delivery";
  if (/picked|in transit|transit|dispatched|shipped|reached|arrived|connected|bagged|in-transit|manifested at hub/.test(t)) return "in_transit";
  if (/pickup (scheduled|generated|pending)|manifest|booked|not picked|pending|awb assigned|ready/.test(t)) return "pending";
  return "in_transit";
}

/* ---------------- Shiprocket ---------------- */
const shiprocket = {
  title: "Shiprocket",
  fields: { credentials: ["email", "password"], options: ["pickupLocation", "courierId", "autoPickup"] },
  help: "Shiprocket → Settings → API → Create an API user (a separate email). Pickup location = the nickname of your pickup address in Shiprocket. Courier ID is optional (blank = Shiprocket's recommended courier).",
  base: (acc) => (acc.baseUrl || "https://apiv2.shiprocket.in").replace(/\/$/, ""),
  async token(acc) {
    if (acc.token && acc.tokenExpires > new Date()) return acc.token;
    need(acc, ["email", "password"]);
    const { status, data } = await request(`${this.base(acc)}/v1/external/auth/login`, { method: "POST", json: { email: acc.credentials.email, password: acc.credentials.password } });
    if (!data.token) throw new Error(`Shiprocket login failed (${status}): ${data.message || short(data)}`);
    acc.token = data.token;
    acc.tokenExpires = new Date(Date.now() + 9 * 86400000);
    await acc.save();
    return acc.token;
  },
  async call(acc, path, opts = {}) {
    const tok = await this.token(acc);
    const res = await request(`${this.base(acc)}/v1/external${path}`, { ...opts, headers: { authorization: `Bearer ${tok}` } });
    if (res.status === 401) {
      acc.tokenExpires = new Date(0);
      throw new Error("Shiprocket session expired; try again");
    }
    return res;
  },
  async book(acc, s) {
    need2(acc, ["pickupLocation"]);
    const [first, ...rest] = s.consignee.name.split(" ");
    const { status, data } = await this.call(acc, "/orders/create/adhoc", {
      method: "POST",
      json: {
        order_id: s.reference,
        order_date: `${ymd(s.orderDate)} ${new Date(s.orderDate.getTime() + 5.5 * 3600000).toISOString().slice(11, 16)}`,
        pickup_location: acc.options.pickupLocation,
        billing_customer_name: first || s.consignee.name,
        billing_last_name: rest.join(" "),
        billing_address: s.consignee.address1,
        billing_address_2: s.consignee.address2,
        billing_city: s.consignee.city,
        billing_pincode: s.consignee.pincode,
        billing_state: s.consignee.stateName,
        billing_country: "India",
        billing_email: s.consignee.email,
        billing_phone: s.consignee.phone,
        shipping_is_billing: true,
        order_items: s.items.map((i) => ({ name: i.name, sku: i.sku || i.name.slice(0, 40), units: i.quantity, selling_price: r2(i.price), discount: 0, tax: i.taxRate, hsn: i.hsn })),
        payment_method: s.cod ? "COD" : "Prepaid",
        sub_total: s.value,
        length: s.length,
        breadth: s.breadth,
        height: s.height,
        weight: s.weight,
      },
    });
    if (!data.shipment_id) throw new Error(`Shiprocket didn't create the order (${status}): ${data.message || short(data.errors || data)}`);
    const refs = { orderId: data.order_id, shipmentId: data.shipment_id };
    const a = await this.call(acc, "/courier/assign/awb", { method: "POST", json: { shipment_id: data.shipment_id, ...(acc.options.courierId ? { courier_id: String(acc.options.courierId) } : {}) } });
    const awbData = a.data?.response?.data || {};
    if (!awbData.awb_code) throw new Error(`Shiprocket created order ${data.order_id} but couldn't assign an AWB: ${awbData.awb_assign_error || a.data?.message || short(a.data)}`);
    if (acc.options.autoPickup) await this.call(acc, "/courier/generate/pickup", { method: "POST", json: { shipment_id: [data.shipment_id] } }).catch(() => {});
    let labelUrl = "";
    try {
      const l = await this.call(acc, "/courier/generate/label", { method: "POST", json: { shipment_id: [data.shipment_id] } });
      labelUrl = l.data?.label_url || "";
    } catch {}
    return { awb: String(awbData.awb_code), courierName: awbData.courier_name || "Shiprocket", labelUrl, trackingUrl: `https://shiprocket.co/tracking/${awbData.awb_code}`, refs };
  },
  async track(acc, sh) {
    const { data } = await this.call(acc, `/courier/track/awb/${encodeURIComponent(sh.awb)}`);
    const td = data.tracking_data || {};
    if (td.error) throw new Error(td.error);
    const cur = td.shipment_track?.[0]?.current_status || td.shipment_status || "";
    const events = (td.shipment_track_activities || []).map((e) => ({ at: new Date(e.date), status: e.activity || e["sr-status-label"], location: e.location }));
    return { status: normStatus(cur), text: cur, events };
  },
  async label(acc, sh) {
    if (!sh.refs?.shipmentId) return null;
    const { data } = await this.call(acc, "/courier/generate/label", { method: "POST", json: { shipment_id: [sh.refs.shipmentId] } });
    return data.label_url ? { url: data.label_url } : null;
  },
  async cancel(acc, sh) {
    const { status, data } = await this.call(acc, "/orders/cancel/shipment/awbs", { method: "POST", json: { awbs: [sh.awb] } });
    if (status >= 400) throw new Error(data.message || short(data));
  },
};

/* ---------------- Delhivery ---------------- */
const delhivery = {
  title: "Delhivery",
  fields: { credentials: ["token"], options: ["clientName", "pickupLocation", "shippingMode"] },
  help: "Delhivery One → Settings → API Setup for the API token. Pickup location must match the warehouse (facility) name registered in Delhivery exactly. Shipping mode: Surface or Express.",
  base: (acc) => (acc.baseUrl || (acc.test ? "https://staging-express.delhivery.com" : "https://track.delhivery.com")).replace(/\/$/, ""),
  h: (acc) => ({ authorization: `Token ${acc.credentials.token}` }),
  async book(acc, s) {
    need(acc, ["token"]);
    need2(acc, ["pickupLocation"]);
    const p = acc.pickup || {};
    const shipment = {
      name: s.consignee.name,
      add: [s.consignee.address1, s.consignee.address2].filter(Boolean).join(", "),
      pin: s.consignee.pincode,
      city: s.consignee.city,
      state: s.consignee.stateName,
      country: "India",
      phone: s.consignee.phone,
      order: s.reference,
      payment_mode: s.cod ? "COD" : "Prepaid",
      return_pin: p.pincode || "",
      return_city: p.city || "",
      return_phone: phone10(p.phone),
      return_add: p.address || "",
      return_state: stateName(p.state),
      return_country: "India",
      products_desc: s.description,
      hsn_code: s.items.map((i) => i.hsn).filter(Boolean).join(","),
      cod_amount: s.cod ? String(s.codAmount) : "0",
      order_date: ymd(s.orderDate),
      total_amount: String(s.value),
      seller_add: s.seller.address,
      seller_name: s.seller.name,
      seller_inv: s.invoiceNumber || "",
      quantity: String(s.items.reduce((n, i) => n + i.quantity, 0)),
      waybill: "",
      shipment_length: String(s.length),
      shipment_width: String(s.breadth),
      shipment_height: String(s.height),
      weight: String(Math.round(s.weight * 1000)),
      seller_gst_tin: s.seller.gstin || "",
      shipping_mode: acc.options.shippingMode || "Surface",
      address_type: "home",
    };
    const payload = { shipments: [shipment], pickup_location: { name: acc.options.pickupLocation } };
    const { status, data } = await request(`${this.base(acc)}/api/cmu/create.json`, { method: "POST", headers: this.h(acc), form: `format=json&data=${encodeURIComponent(JSON.stringify(payload))}` });
    const pkg = data.packages?.[0];
    if (!pkg?.waybill || (pkg.status && !/success/i.test(pkg.status))) {
      const why = (pkg?.remarks || []).join("; ") || data.rmk || data.error || data.detail || short(data);
      throw new Error(`Delhivery didn't book the shipment (${status}): ${why}`);
    }
    return { awb: String(pkg.waybill), courierName: `Delhivery ${acc.options.shippingMode || "Surface"}`, trackingUrl: `https://www.delhivery.com/track-v2/package/${pkg.waybill}`, refs: { refnum: pkg.refnum, routing: pkg.sort_code || "" } };
  },
  async track(acc, sh) {
    const { data } = await request(`${this.base(acc)}/api/v1/packages/json/?waybill=${encodeURIComponent(sh.awb)}`, { headers: this.h(acc) });
    const sd = data.ShipmentData?.[0]?.Shipment;
    if (!sd) throw new Error(data.Error || data.detail || "No tracking yet");
    const st = sd.Status || {};
    let status = normStatus(st.Status);
    if (st.StatusType === "DL" && /rto/i.test(st.Status) === false) status = "delivered";
    if (st.StatusType === "RT" || /rto/i.test(st.Status)) status = st.StatusType === "DL" || /delivered/i.test(st.Status) ? "rto" : "rto";
    if (st.StatusType === "CN") status = "cancelled";
    const events = (sd.Scans || []).map((x) => x.ScanDetail).filter(Boolean).map((d) => ({ at: new Date(d.ScanDateTime || d.StatusDateTime), status: d.Instructions || d.Scan, location: d.ScannedLocation }));
    return { status, text: st.Status, events };
  },
  async label(acc, sh) {
    const { data } = await request(`${this.base(acc)}/api/p/packing_slip?wbns=${encodeURIComponent(sh.awb)}&pdf=true`, { headers: this.h(acc) });
    const link = data.packages?.[0]?.pdf_download_link;
    return link ? { url: link } : null;
  },
  async cancel(acc, sh) {
    const { status, data } = await request(`${this.base(acc)}/api/p/edit`, { method: "POST", headers: this.h(acc), json: { waybill: sh.awb, cancellation: "true" } });
    if (status >= 400 || data.status === false) throw new Error(data.error || data.remark || short(data));
  },
};

/* ---------------- Blue Dart ---------------- */
const bluedart = {
  title: "Blue Dart",
  fields: { credentials: ["licenceKey", "loginId", "clientId", "clientSecret", "trackingKey"], options: ["customerCode", "originArea", "productCode", "vendorCode", "autoPickup"] },
  help: "From Blue Dart (NetConnect / API portal): Licence key, Login ID, Client ID and secret, and the separate tracking API key if you have one. Customer code and pickup area code are on your contract. Service: A = eTail Apex (air), E = Surface. COD orders are sent as COD automatically.",
  base: (acc) => (acc.baseUrl || (acc.test ? "https://apigateway-sandbox.bluedart.com/in/transportation" : "https://apigateway.bluedart.com/in/transportation")).replace(/\/$/, ""),
  profile: (acc) => ({ LoginID: acc.credentials.loginId, LicenceKey: acc.credentials.licenceKey, Api_type: "S" }),
  async token(acc) {
    if (acc.token && acc.tokenExpires > new Date()) return acc.token;
    need(acc, ["clientId", "clientSecret"]);
    const { status, data } = await request(`${this.base(acc)}/token/v1/login`, { headers: { ClientID: acc.credentials.clientId, clientSecret: acc.credentials.clientSecret } });
    if (!data.JWTToken) throw new Error(`Blue Dart login failed (${status}): ${short(data)}`);
    acc.token = data.JWTToken;
    acc.tokenExpires = new Date(Date.now() + 6 * 3600000);
    await acc.save();
    return acc.token;
  },
  async book(acc, s) {
    need(acc, ["loginId", "licenceKey"]);
    need2(acc, ["customerCode", "originArea"]);
    pickupOk(acc);
    const tok = await this.token(acc);
    const p = acc.pickup;
    const split = (t) => [t.slice(0, 30), t.slice(30, 60), t.slice(60, 90)];
    const [c1, c2, c3] = split([s.consignee.address1, s.consignee.address2, s.consignee.city].filter(Boolean).join(", "));
    const [p1, p2, p3] = split(p.address);
    const body = {
      Request: {
        Consignee: { ConsigneeName: s.consignee.name.slice(0, 30), ConsigneeAddress1: c1, ConsigneeAddress2: c2, ConsigneeAddress3: c3, ConsigneePincode: s.consignee.pincode, ConsigneeMobile: s.consignee.phone, ConsigneeEmailID: s.consignee.email, ConsigneeAttention: s.consignee.name.slice(0, 30) },
        Shipper: { CustomerCode: acc.options.customerCode, CustomerName: (p.name || s.seller.name).slice(0, 30), CustomerAddress1: p1, CustomerAddress2: p2, CustomerAddress3: p3, CustomerPincode: p.pincode, CustomerMobile: phone10(p.phone), OriginArea: acc.options.originArea, Sender: s.seller.name.slice(0, 30), VendorCode: acc.options.vendorCode || "", IsToPayCustomer: false, CustomerGSTNumber: s.seller.gstin || "" },
        Returnadds: { ReturnAddress1: p1, ReturnAddress2: p2, ReturnAddress3: p3, ReturnPincode: p.pincode, ReturnMobile: phone10(p.phone), ReturnContact: p.name || s.seller.name },
        Services: {
          ProductCode: acc.options.productCode || "A",
          SubProductCode: s.cod ? "C" : "P",
          ActualWeight: String(s.weight),
          CollectableAmount: s.cod ? s.codAmount : 0,
          DeclaredValue: s.value,
          CreditReferenceNo: s.reference,
          InvoiceNo: s.invoiceNumber || s.reference,
          PieceCount: "1",
          Dimensions: [{ Length: s.length, Breadth: s.breadth, Height: s.height, Count: 1 }],
          PickupDate: `/Date(${Date.now()})/`,
          PickupTime: "1600",
          RegisterPickup: !!acc.options.autoPickup,
          PDFOutputNotRequired: false,
          Commodity: { CommodityDetail1: s.description.slice(0, 30) },
          itemdtl: s.items.map((i) => ({ ItemName: i.name.slice(0, 50), Itemquantity: i.quantity, ItemValue: r2(i.price * i.quantity), HSCode: i.hsn, SKUNumber: i.sku })),
        },
      },
      Profile: this.profile(acc),
    };
    const { status, data } = await request(`${this.base(acc)}/waybill/v1/GenerateWayBill`, { method: "POST", headers: { JWTToken: tok }, json: body });
    const r = data.GenerateWayBillResult || data;
    if (!r.AWBNo || r.IsError) {
      const why = (r.Status || []).map((x) => x.StatusInformation).join("; ") || data["error-response"]?.[0]?.Status?.[0]?.StatusInformation || short(data);
      throw new Error(`Blue Dart didn't generate a waybill (${status}): ${why}`);
    }
    const out = { awb: String(r.AWBNo), courierName: "Blue Dart", trackingUrl: `https://www.bluedart.com/web/guest/trackdartresultthirdparty?trackFor=0&trackNo=${r.AWBNo}`, refs: { routing: [r.DestinationArea, r.DestinationLocation].filter(Boolean).join("/"), token: r.TokenNumber } };
    if (Array.isArray(r.AWBPrintContent) && r.AWBPrintContent.length) out.labelPdf = Buffer.from(r.AWBPrintContent);
    return out;
  },
  async track(acc, sh) {
    need(acc, ["loginId"]);
    const key = acc.credentials.trackingKey || acc.credentials.licenceKey;
    const url = `${acc.options.trackUrl || "https://api.bluedart.com/servlet/RoutingServlet"}?${new URLSearchParams({ handler: "tnt", action: "custawbquery", loginid: acc.credentials.loginId, awb: "awb", numbers: sh.awb, format: "xml", lickey: key, verno: "1.3", scan: "1" })}`;
    const res = await request(url);
    const xml = res.data.raw || "";
    const { XMLParser } = require("fast-xml-parser");
    const doc = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", isArray: (t) => t === "ScanDetail" || t === "Shipment" }).parse(xml);
    const sh0 = doc.ShipmentData?.Shipment?.[0];
    if (!sh0 || sh0.StatusType === "NF" || !sh0.Status) throw new Error(sh0?.Status || "No tracking yet");
    const scans = sh0.Scans?.ScanDetail || [];
    const events = scans.map((d) => ({ at: new Date(`${String(d.ScanDate).split("-").reverse().join("-")} ${d.ScanTime || ""}`.replace(/(\d{2})-([A-Za-z]{3})-(\d{4})/, "$1 $2 $3")), status: d.Scan, location: d.ScannedLocation }));
    let status = normStatus(sh0.Status);
    if (sh0.StatusType === "DL") status = /rto|return/i.test(sh0.Status) ? "rto" : "delivered";
    if (sh0.StatusType === "RT") status = "rto";
    return { status, text: sh0.Status, events };
  },
  async label() {
    return null;
  },
  async cancel(acc, sh) {
    const tok = await this.token(acc);
    const { data } = await request(`${this.base(acc)}/waybill/v1/CancelWaybill`, { method: "POST", headers: { JWTToken: tok }, json: { Request: { AWBNo: sh.awb }, Profile: this.profile(acc) } });
    const r = data.CancelWaybillResult || data;
    if (r.IsError) throw new Error((r.Status || []).map((x) => x.StatusInformation).join("; ") || short(data));
  },
};

/* ---------------- DTDC (Shipsy) ---------------- */
const dtdc = {
  title: "DTDC",
  fields: { credentials: ["apiKey", "trackingToken"], options: ["customerCode", "serviceType", "commodityId"] },
  help: "From your DTDC account manager: the API key and customer code for booking, and the tracking access token (looks like CUSTOMERCODE_trk_json:…). Service type as enabled on your account, e.g. B2C SMART EXPRESS, B2C PRIORITY, GROUND EXPRESS.",
  base: (acc) => (acc.baseUrl || (acc.test ? "https://demodashboardapi.shipsy.in" : "https://dtdcapi.shipsy.io")).replace(/\/$/, ""),
  addr(a) {
    return { name: a.name, phone: a.phone, address_line_1: a.address1, address_line_2: a.address2 || "", pincode: a.pincode, city: a.city, state: a.stateName };
  },
  async book(acc, s) {
    need(acc, ["apiKey"]);
    need2(acc, ["customerCode"]);
    pickupOk(acc);
    const p = acc.pickup;
    const origin = { name: p.name || s.seller.name, phone: phone10(p.phone), address1: p.address, address2: "", pincode: p.pincode, city: p.city, stateName: stateName(p.state) };
    const consignment = {
      customer_code: acc.options.customerCode,
      service_type_id: acc.options.serviceType || "B2C PRIORITY",
      load_type: "NON-DOCUMENT",
      description: s.description,
      dimension_unit: "cm",
      length: String(s.length),
      width: String(s.breadth),
      height: String(s.height),
      weight_unit: "kg",
      weight: String(s.weight),
      declared_value: String(s.value),
      num_pieces: "1",
      customer_reference_number: s.reference,
      commodity_id: acc.options.commodityId || "99",
      is_risk_surcharge_applicable: false,
      cod_collection_mode: s.cod ? "cash" : "",
      cod_amount: s.cod ? String(s.codAmount) : "",
      invoice_number: s.invoiceNumber || "",
      origin_details: this.addr(origin),
      return_details: this.addr(origin),
      destination_details: this.addr(s.consignee),
    };
    const { status, data } = await request(`${this.base(acc)}/api/customer/integration/consignment/softdata`, { method: "POST", headers: { "api-key": acc.credentials.apiKey }, json: { consignments: [consignment] } });
    const r = data.data?.[0];
    if (!r?.success || !r.reference_number) throw new Error(`DTDC didn't book the shipment (${status}): ${r?.message || data.error?.message || data.message || short(data)}`);
    return { awb: String(r.reference_number), courierName: "DTDC", trackingUrl: `https://www.dtdc.in/trace.asp?strCnno=${r.reference_number}`, refs: {} };
  },
  async track(acc, sh) {
    need(acc, ["trackingToken"]);
    const base = acc.options.trackBaseUrl || "https://blktracksvc.dtdc.com/dtdc-api";
    const { data } = await request(`${base}/rest/JSONCnTrk/getTrackDetails`, { method: "POST", headers: { "X-Access-Token": acc.credentials.trackingToken }, json: { trkType: "cnno", strcnno: sh.awb, addtnlDtl: "Y" } });
    const st = data.trackHeader?.strStatus || "";
    if (!st) throw new Error(data.statusMessage || data.errorDetails?.[0]?.value || "No tracking yet");
    const events = (data.trackDetails || []).map((d) => ({ at: new Date(`${(d.strActionDate || "").replace(/(\d{2})(\d{2})(\d{4})/, "$3-$2-$1")}T${(d.strActionTime || "0000").replace(/(\d{2})(\d{2})/, "$1:$2")}:00+05:30`), status: d.strAction, location: d.strOrigin }));
    return { status: normStatus(st), text: st, events };
  },
  async label(acc, sh) {
    const res = await request(`${this.base(acc)}/api/customer/integration/consignment/shippinglabel/stream?reference_number=${encodeURIComponent(sh.awb)}&label_code=SHIP_LABEL_4X6&label_format=pdf`, { headers: { "api-key": acc.credentials.apiKey }, binary: true });
    if (res.buffer) return { pdf: res.buffer };
    const b64 = res.data?.data?.[0]?.label || res.data?.label;
    return b64 ? { pdf: Buffer.from(b64, "base64") } : null;
  },
  async cancel(acc, sh) {
    const { data } = await request(`${this.base(acc)}/api/customer/integration/consignment/cancel`, { method: "POST", headers: { "api-key": acc.credentials.apiKey }, json: { AWBNo: [sh.awb], customerCode: acc.options.customerCode } });
    if (data.success === false || data.status === "FAILED") throw new Error(data.message || short(data));
  },
};

/* ---------------- Shadowfax ---------------- */
const shadowfax = {
  title: "Shadowfax",
  fields: { credentials: ["token"], options: [] },
  help: "API token from your Shadowfax account manager (D2C / marketplace API). If Shadowfax gave you a different API address, put it in API address.",
  base: (acc) => (acc.baseUrl || (acc.test ? "https://dale.staging.shadowfax.in" : "https://dale.shadowfax.in")).replace(/\/$/, ""),
  h: (acc) => ({ authorization: `Token ${acc.credentials.token}` }),
  async book(acc, s) {
    need(acc, ["token"]);
    pickupOk(acc);
    const p = acc.pickup;
    const pick = { name: p.name || s.seller.name, contact: phone10(p.phone), address_line_1: p.address, address_line_2: "", city: p.city, state: stateName(p.state), pincode: p.pincode };
    const body = {
      order_type: "marketplace",
      order_details: { client_order_id: s.reference, actual_weight: Math.round(s.weight * 1000), volumetric_weight: Math.round(((s.length * s.breadth * s.height) / 5000) * 1000), product_value: s.value, payment_mode: s.cod ? "COD" : "Prepaid", cod_amount: s.cod ? s.codAmount : 0, total_amount: s.value, order_date: ymd(s.orderDate) },
      customer_details: { name: s.consignee.name, contact: s.consignee.phone, address_line_1: s.consignee.address1, address_line_2: s.consignee.address2 || "", city: s.consignee.city, state: s.consignee.stateName, pincode: s.consignee.pincode, alternate_contact: "" },
      pickup_details: pick,
      rts_details: pick,
      product_details: s.items.map((i) => ({ hsn_code: i.hsn, invoice_no: s.invoiceNumber || s.reference, sku_name: i.name, sku_id: i.sku || i.name.slice(0, 30), category: i.category || "", price: r2(i.price * i.quantity), seller_details: { seller_name: s.seller.name, seller_address: s.seller.address, seller_state: s.seller.stateName, gstin_number: s.seller.gstin || "" } })),
    };
    const { status, data } = await request(`${this.base(acc)}/api/v3/clients/orders/`, { method: "POST", headers: this.h(acc), json: body });
    const awb = data.data?.awb_number || data.awb_number;
    if (!awb) throw new Error(`Shadowfax didn't book the shipment (${status}): ${data.message || data.errors || short(data)}`);
    return { awb: String(awb), courierName: "Shadowfax", trackingUrl: `https://tracker.shadowfax.in/#/track/${awb}`, refs: {} };
  },
  async track(acc, sh) {
    const { data } = await request(`${this.base(acc)}/api/v4/clients/orders/${encodeURIComponent(sh.awb)}/track/?format=json`, { headers: this.h(acc) });
    const st = data.order_details?.status || data.status || "";
    if (!st) throw new Error(data.message || short(data));
    const events = (data.tracking_details || []).map((d) => ({ at: new Date(d.created), status: d.remarks || d.status, location: d.location }));
    return { status: normStatus(st), text: st, events };
  },
  async label() {
    return null;
  },
  async cancel(acc, sh) {
    const { status, data } = await request(`${this.base(acc)}/api/v3/clients/orders/cancel/`, { method: "POST", headers: this.h(acc), json: { request_id: sh.awb, cancel_remarks: "Cancelled by seller" } });
    if (status >= 400) throw new Error(data.message || short(data));
  },
};

/* ---------------- Custom / manual ---------------- */
const custom = {
  title: "Custom courier",
  fields: { credentials: [], options: ["awbPool", "pincodes"] },
  help: "Couriers without an API (self delivery, local couriers, India Post…): paste a stock of AWB numbers to use one per shipment, or type the AWB when booking. Optionally limit it to certain pincodes. Tracking link: use {awb} where the number goes.",
  async book(acc, s, manual = {}) {
    const pins = String(acc.options.pincodes || "").split(/[\s,;]+/).filter(Boolean);
    if (pins.length && !pins.includes(s.consignee.pincode)) throw new Error(`${acc.name} doesn't deliver to ${s.consignee.pincode}`);
    let awb = (manual.awb || "").trim();
    if (!awb) {
      // Next unused AWB from the uploaded stock.
      const pool = String(acc.options.awbPool || "").split(/[\s,;]+/).filter(Boolean);
      if (!pool.length) throw new Error(`Enter the AWB, or upload AWB numbers for ${acc.name} in Shopify Settings → Couriers`);
      awb = pool.shift();
      acc.options = { ...acc.options, awbPool: pool.join("\n") };
      acc.markModified("options");
      await acc.save();
    }
    return { awb, courierName: manual.courierName || acc.name, trackingUrl: acc.trackingUrl ? acc.trackingUrl.replace("{awb}", encodeURIComponent(awb)) : "", refs: {} };
  },
  async track() {
    throw new Error("Custom couriers aren't tracked automatically — update the status from the order");
  },
  async label() {
    return null;
  },
  async cancel() {},
};

const CARRIERS = { shiprocket, delhivery, bluedart, dtdc, shadowfax, custom };

// Amount to collect on delivery: all of a COD order, the unpaid part of a partly paid one.
function codOf(order) {
  if (order.paymentMode === "prepaid") return 0;
  if (order.codAmount > 0) return r2(order.codAmount);
  return order.paymentMode === "cod" ? r2(order.outstanding > 0 ? order.outstanding : order.total) : 0;
}

// Everything a carrier needs, from a Shopify order.
function shipmentFrom(order, org, pkg, itemMap = new Map()) {
  const a = order.shippingAddress || {};
  const items = order.lines.filter((l) => l.quantity > 0).map((l) => ({ name: l.variantTitle ? `${l.title} - ${l.variantTitle}` : l.title, sku: l.sku, quantity: l.quantity, price: l.quantity ? r2(l.total / l.quantity) : 0, hsn: itemMap.get(String(l.item))?.hsnSac || l.hsn || "", taxRate: itemMap.get(String(l.item))?.taxRate ?? (l.shopifyTaxRate || 0), category: l.productType || "" }));
  const orgAddr = org.address || {};
  return {
    reference: String(order.name || order.orderNumber).replace(/^#/, ""),
    orderDate: order.orderDate,
    cod: codOf(order) > 0,
    codAmount: codOf(order),
    prepaidAmount: r2(order.prepaidAmount || 0),
    value: r2(order.total),
    invoiceNumber: order.invoiceNumber || "",
    description: items.map((i) => i.name).join(", ").slice(0, 100) || "Goods",
    items,
    weight: Number(pkg.weight) || 0.5,
    length: Number(pkg.length) || 10,
    breadth: Number(pkg.breadth) || 10,
    height: Number(pkg.height) || 10,
    consignee: { name: a.name || order.customer?.name || "Customer", phone: phone10(a.phone || order.customer?.phone), email: order.customer?.email || "", address1: a.address1 || "", address2: a.address2 || "", city: a.city || "", state: a.state, stateName: a.province || stateName(a.state), pincode: a.zip || "" },
    seller: { name: org.name, gstin: org.gstin || "", address: [orgAddr.street, orgAddr.city, orgAddr.pincode].filter(Boolean).join(", "), stateName: stateName(org.state) },
  };
}

function checkShipment(s) {
  const c = s.consignee;
  const miss = [];
  if (!c.address1) miss.push("address");
  if (!/^\d{6}$/.test(c.pincode)) miss.push("6-digit pincode");
  if (c.phone.length !== 10) miss.push("10-digit phone");
  if (!c.city) miss.push("city");
  if (miss.length) throw new Error(`Shipping address is missing: ${miss.join(", ")} — fix it in Shopify and sync again`);
}

module.exports = { CARRIERS, shipmentFrom, checkShipment, normStatus, stateName, codOf };
