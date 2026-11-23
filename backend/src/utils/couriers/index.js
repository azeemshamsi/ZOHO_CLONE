/**
 * Courier integrations. Each carrier exposes:
 *   book(acc, s)      → { awb, courierName, labelUrl?, trackingUrl?, refs? }
 *   track(acc, sh)    → { status: picked|in_transit|out_for_delivery|delivered|rto|cancelled|pending, text, events[] }
 *   label(acc, sh)    → { url } | { pdf: Buffer } | null   (null → OrdexaGo prints its own 4x6 label)
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

// Map courier status text to OrdexaGo's tracking states.
function normStatus(text) {
  const t = String(text || "").toLowerCase();
  if (/rto|return(ed)? to origin|returned|return delivered|rt[- ]?(in|delivered)/.test(t)) return "rto";
  // "Pickup cancelled" is the pickup, not the AWB: still booked, waiting for a pickup.
  if (/cancel/.test(t) && !/pick ?up|pickup/.test(t)) return "cancelled";
  if (/^delivered|delivered$|\bdelivered\b/.test(t) && !/not delivered|undelivered/.test(t)) return "delivered";
  if (/out for delivery|ofd/.test(t)) return "out_for_delivery";
  // Booked but not yet with the courier — checked before the "picked / transit" words ("Not Picked", "Out for pickup").
  if (/not picked|pick ?up (scheduled|generated|pending|rescheduled|exception|error|failed|on hold|cancelled|queued)|out for pick ?up|assigned[ _]for[ _]pick ?up|pick ?up[ _]on[ _]hold|pending pick ?up|ready (to ship|for pick ?up)|awb assigned|label generated|shipment (created|booked)|order (placed|created)|softdata|^manifest(ed)?$|^booked|^new$|^open$|^created$|^not yet picked/.test(t)) return "pending";
  if (/picked|in transit|transit|dispatched|shipped|reached|arrived|connected|bagged|in-transit|manifested at hub|received at|departed|forwarded/.test(t)) return "in_transit";
  // Anything else isn't proof the parcel left: keep it ready to ship until a pickup / transit scan.
  return "pending";
}

// A pickup or transit scan in the history means the courier has the parcel, whatever the latest status says.
const HANDED_OVER = /picked up|pickup done|picked|in transit|in-transit|dispatched|received at|bagged|departed|forwarded|reached|arrived/i;
const handedOver = (events) => (events || []).some((e) => HANDED_OVER.test(String(e.status || "")) && !/not picked|not yet picked|out for pick ?up/i.test(String(e.status || "")));

// The courier account with its pickup address swapped for the customer's (reverse pickups).
const pickupAt = (acc, c) => {
  const pickup = { name: c.name, address: [c.address1, c.address2].filter(Boolean).join(", "), pincode: c.pincode, phone: c.phone, city: c.city, state: c.state };
  return new Proxy(acc, { get: (t, k) => (k === "pickup" ? pickup : k === "_sellerView" ? false : Reflect.get(t, k, t)), set: (t, k, v) => ((t[k] = v), true) });
};

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
  async book(acc, s, manual = {}) {
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
    const a = await this.call(acc, "/courier/assign/awb", { method: "POST", json: { shipment_id: data.shipment_id, ...(manual.courierId || acc.options.courierId ? { courier_id: String(manual.courierId || acc.options.courierId) } : {}) } });
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
  // Reverse pickup (return): picked up from the customer (s.from), delivered to acc.pickup.
  async reverse(acc, s) {
    const c = s.from;
    const to = acc.pickup || {};
    const [first, ...rest] = (c.name || "Customer").split(" ");
    const now = new Date(Date.now() + 330 * 60000);
    const { status, data } = await this.call(acc, "/orders/create/return", {
      method: "POST",
      json: {
        order_id: s.reference,
        order_date: now.toISOString().slice(0, 10),
        pickup_customer_name: first,
        pickup_last_name: rest.join(" "),
        pickup_address: c.address1,
        pickup_address_2: c.address2 || "",
        pickup_city: c.city,
        pickup_state: c.stateName,
        pickup_country: "India",
        pickup_pincode: c.pincode,
        pickup_email: c.email || "",
        pickup_phone: c.phone,
        shipping_customer_name: to.name || s.seller.name,
        shipping_last_name: "",
        shipping_address: to.address,
        shipping_address_2: "",
        shipping_city: to.city || "",
        shipping_state: stateName(to.state),
        shipping_country: "India",
        shipping_pincode: to.pincode,
        shipping_phone: phone10(to.phone),
        order_items: s.items.map((i) => ({ name: i.name, sku: i.sku || i.name.slice(0, 40), units: i.quantity, selling_price: r2(i.price), discount: 0, hsn: i.hsn, qc_enable: false })),
        payment_method: "PREPAID",
        sub_total: s.value,
        length: s.length,
        breadth: s.breadth,
        height: s.height,
        weight: s.weight,
      },
    });
    if (!data.shipment_id) throw new Error(`Shiprocket didn't create the return (${status}): ${data.message || short(data.errors || data)}`);
    const a = await this.call(acc, "/courier/assign/awb", { method: "POST", json: { shipment_id: data.shipment_id, is_return: 1 } });
    const awbData = a.data?.response?.data || {};
    if (!awbData.awb_code) throw new Error(`Shiprocket created return ${data.order_id} but couldn't assign an AWB: ${awbData.awb_assign_error || a.data?.message || short(a.data)}`);
    return { awb: String(awbData.awb_code), courierName: awbData.courier_name || "Shiprocket", trackingUrl: `https://shiprocket.co/tracking/${awbData.awb_code}`, refs: { orderId: data.order_id, shipmentId: data.shipment_id } };
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
      payment_mode: s.reverse ? "Pickup" : s.cod ? "COD" : "Prepaid",
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
  // Reverse pickup: Delhivery's "Pickup" mode — collected from the customer, back to the pickup location.
  reverse(acc, s) {
    return this.book(acc, { ...s, consignee: s.from, cod: false, codAmount: 0, reverse: true });
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
    const wantPickup = this.pickupOn(acc);
    const when = this.pickupDay();
    const area = await this.areaFor(acc);
    const split = (t) => [t.slice(0, 30), t.slice(30, 60), t.slice(60, 90)];
    const [c1, c2, c3] = split([s.consignee.address1, s.consignee.address2, s.consignee.city].filter(Boolean).join(", "));
    const [p1, p2, p3] = split(p.address);
    const body = {
      Request: {
        Consignee: { ConsigneeName: s.consignee.name.slice(0, 30), ConsigneeAddress1: c1, ConsigneeAddress2: c2, ConsigneeAddress3: c3, ConsigneePincode: s.consignee.pincode, ConsigneeMobile: s.consignee.phone, ConsigneeEmailID: s.consignee.email, ConsigneeAttention: s.consignee.name.slice(0, 30) },
        Shipper: { CustomerCode: acc.options.customerCode, CustomerName: (p.name || s.seller.name).slice(0, 30), CustomerAddress1: p1, CustomerAddress2: p2, CustomerAddress3: p3, CustomerPincode: p.pincode, CustomerMobile: phone10(p.phone), OriginArea: area, Sender: s.seller.name.slice(0, 30), VendorCode: acc.options.vendorCode || "", IsToPayCustomer: false, CustomerGSTNumber: s.seller.gstin || "" },
        Returnadds: { ReturnAddress1: p1, ReturnAddress2: p2, ReturnAddress3: p3, ReturnPincode: p.pincode, ReturnMobile: phone10(p.phone), ReturnContact: p.name || s.seller.name },
        Services: {
          ProductCode: acc.options.productCode || "A",
          SubProductCode: s.cod ? "C" : "P",
          ActualWeight: String(s.weight),
          CollectableAmount: s.cod ? s.codAmount : 0,
          DeclaredValue: s.value,
          // Blue Dart takes letters and digits only here: "201265-2" (a re-booking) → "201265R2"; invoice
          // "SH/26-27/381" → "SH2627381" (the order number when not invoiced yet).
          CreditReferenceNo: String(s.reference).replace(/-(\d+)$/, "R$1").replace(/[^A-Za-z0-9]/g, "").slice(0, 20),
          InvoiceNo: String(s.invoiceNumber || s.reference.replace(/-\d+$/, "")).replace(/[^A-Za-z0-9]/g, "").slice(0, 20),
          PieceCount: "1",
          Dimensions: [{ Length: s.length, Breadth: s.breadth, Height: s.height, Count: 1 }],
          PickupDate: `/Date(${when.ms})/`,
          PickupTime: "1600",
          RegisterPickup: wantPickup,
          IsReversePickup: !!s.reverse,
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
    const out = { awb: String(r.AWBNo), courierName: "Blue Dart", trackingUrl: `https://www.bluedart.com/web/guest/trackdartresultthirdparty?trackFor=0&trackNo=${r.AWBNo}`, refs: { routing: [r.DestinationArea, r.DestinationLocation].filter(Boolean).join("/"), area } };
    if (Array.isArray(r.AWBPrintContent) && r.AWBPrintContent.length) out.labelPdf = Buffer.from(r.AWBPrintContent);
    // Pickup: the waybill call registers it when it can (token comes back); otherwise it's registered on its own.
    if (wantPickup) {
      if (r.TokenNumber && String(r.TokenNumber) !== "0") Object.assign(out.refs, { token: String(r.TokenNumber), pickupDate: when.day });
      else {
        try {
          Object.assign(out.refs, await this.registerPickup(acc, { ...s, awb: out.awb, area }));
        } catch (e) {
          out.refs.pickupError = e.message;
        }
      }
    }
    return out;
  },
  // On unless switched off in the account (Blue Dart doesn't come for a parcel without a registered pickup).
  pickupOn: (acc) => acc.options?.autoPickup !== false && acc.options?.autoPickup !== "false",
  // Today if booked before 2 pm (India), else the next day; never a Sunday. → { ms, day: "YYYY-MM-DD" }
  pickupDay(now = Date.now()) {
    const ist = new Date(now + 330 * 60000);
    if (ist.getUTCHours() >= 14) ist.setUTCDate(ist.getUTCDate() + 1);
    if (ist.getUTCDay() === 0) ist.setUTCDate(ist.getUTCDate() + 1);
    const day = ist.toISOString().slice(0, 10);
    return { ms: Date.parse(`${day}T12:00:00+05:30`), day };
  },
  // Reverse pickup: Blue Dart collects from the customer (as the shipper) and delivers to acc.pickup.
  async reverse(acc, s) {
    const c = s.from;
    const accRev = pickupAt(acc, c);
    const to = acc.pickup || {};
    const consignee = { name: to.name || s.seller.name, address1: to.address || "", address2: "", city: to.city || "", pincode: to.pincode, phone: phone10(to.phone), email: "", state: to.state, stateName: stateName(to.state) };
    return this.book(accRev, { ...s, consignee, seller: { ...s.seller, name: c.name || s.seller.name }, cod: false, codAmount: 0, reverse: true });
  },
  // Blue Dart area code of the pickup. A customer code works only in its own area, so it's the seller's own
  // area + customer code when saved on the seller (Store → Sellers → courier codes), else the account's.
  async areaFor(acc) {
    return acc.options.originArea;
  },
  // Register the pickup of a booked waybill → { token, pickupDate }.
  async registerPickup(acc, s) {
    const tok = await this.token(acc);
    const p = acc.pickup;
    const when = this.pickupDay();
    const split = (t) => [t.slice(0, 30), t.slice(30, 60), t.slice(60, 90)];
    const [p1, p2, p3] = split(p.address || "");
    const body = {
      request: {
        AWBNo: [s.awb],
        AreaCode: s.area || acc.options.originArea,
        CISDDN: false,
        ContactPersonName: (p.name || s.seller?.name || "").slice(0, 30),
        CustomerAddress1: p1,
        CustomerAddress2: p2,
        CustomerAddress3: p3,
        CustomerCode: acc.options.customerCode,
        CustomerName: (p.name || s.seller?.name || "").slice(0, 30),
        CustomerPincode: p.pincode,
        CustomerTelephoneNumber: "",
        DoxNDox: "2",
        EmailID: "",
        IsForcePickup: false,
        IsReversePickup: !!s.reverse,
        MobileTelNo: phone10(p.phone),
        NumberofPieces: "1",
        OfficeCloseTime: "1800",
        PackType: "",
        ProductCode: acc.options.productCode || "A",
        ReferenceNo: s.reference || "",
        Remarks: "",
        RouteCode: "",
        ShipmentPickupDate: `/Date(${when.ms})/`,
        ShipmentPickupTime: "1600",
        SubProducts: ["E-Tailing"],
        VolumeWeight: Number(s.weight) || 0.5,
        WeightofShipment: Number(s.weight) || 0.5,
        isToPayShipper: false,
      },
      profile: this.profile(acc),
    };
    const { status, data } = await request(`${this.base(acc)}/pickup/v1/RegisterPickup`, { method: "POST", headers: { JWTToken: tok }, json: body });
    const r = data.RegisterPickupResult || data;
    if (r.IsError || !r.TokenNumber) {
      const errs = [...(r.Status || []), ...(data["error-response"] || []).flatMap((x) => x.Status || [x])];
      const why = errs.map((x) => x.StatusInformation).filter(Boolean).join("; ") || short(data);
      // Area code + customer code that don't belong together (e.g. a seller's pickup in another Blue Dart area).
      if (errs.some((x) => /UnauthorizedUser/i.test(x.StatusCode || "")) || /not authori[sz]ed/i.test(why)) {
        if (s.area && s.area !== acc.options.originArea) return this.registerPickup(acc, { ...s, area: acc.options.originArea });
        throw new Error(
          acc._sellerView && !acc.options._sellerArea
            ? `Blue Dart won't take a pickup at ${p.pincode} on customer code ${acc.options.customerCode} (area ${body.request.AreaCode}): that code is for your own pickup area. Ask Blue Dart for a customer code and area code for this seller's pickup address, and save them on the seller (Store → Sellers → courier codes).`
            : `Blue Dart says customer code ${acc.options.customerCode} isn't allowed to book pickups in area ${body.request.AreaCode}. Check the customer code and pickup area code in the Blue Dart account (Store → Settings → Couriers) with Blue Dart.`
        );
      }
      throw new Error(`Blue Dart didn't register the pickup (${status}): ${why}`);
    }
    return { token: String(r.TokenNumber), pickupDate: when.day, pickupError: "" };
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
      service_type_id: acc.options.serviceType || "B2C SMART EXPRESS", // the settings form's first choice
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
      return_details: this.addr(s.reverse ? s.consignee : origin),
      destination_details: this.addr(s.consignee),
      ...(s.reverse ? { consignment_type: "reverse" } : {}),
    };
    const { status, data } = await request(`${this.base(acc)}/api/customer/integration/consignment/softdata`, { method: "POST", headers: { "api-key": acc.credentials.apiKey }, json: { consignments: [consignment] } });
    const r = data.data?.[0];
    if (!r?.success || !r.reference_number) {
      const why = r?.message || r?.reason || data.error?.message || data.message || short(data);
      if (/NO_SERIES_AVAILABLE/i.test(why)) throw new Error(`DTDC has no AWB numbers left for customer code ${acc.options.customerCode} with service "${consignment.service_type_id}" (NO_SERIES_AVAILABLE). Try another service type in the courier settings, or ask DTDC to allot an AWB series for API bookings on this service.`);
      throw new Error(`DTDC didn't book the shipment (${status}): ${why}`);
    }
    return { awb: String(r.reference_number), courierName: "DTDC", trackingUrl: `https://www.dtdc.in/trace.asp?strCnno=${r.reference_number}`, refs: {} };
  },
  // Reverse pickup: a "reverse" consignment from the customer to acc.pickup.
  reverse(acc, s) {
    const c = s.from;
    const to = acc.pickup || {};
    const accRev = pickupAt(acc, c);
    const consignee = { name: to.name || s.seller.name, phone: phone10(to.phone), address1: to.address || "", address2: "", pincode: to.pincode, city: to.city || "", stateName: stateName(to.state) };
    return this.book(accRev, { ...s, consignee, cod: false, codAmount: 0, reverse: true });
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


/* ---------------- Shiprocket Cargo (B2B, api-cargo.shiprocket.in) ---------------- */
// One docket for all the boxes of an order. Booking is two steps: order_creation (gives the carriers and the
// transporter ID for the e-way bill) then order_shipment_association (books it: docket number + label, or, when
// the account is set to async, a shipment ID whose docket comes later — tracking picks it up).
const CARGO_TRACK = (awb) => `https://app-cargo.shiprocket.in/tracking/${encodeURIComponent(awb)}`;
const cargoEmail = (v) => (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(v || "").trim()) ? String(v).trim() : "");
const cargoErr = (d) => {
  if (!d || typeof d !== "object") return String(d || "");
  if (d.message || d.detail || d.error) return String(d.message || d.detail || d.error);
  return Object.entries(d)
    .filter(([k]) => k !== "success")
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : typeof v === "object" ? JSON.stringify(v) : v}`)
    .join("; ")
    .slice(0, 400);
};
const shiprocket_cargo = {
  title: "Shiprocket Cargo",
  multiPackage: true, // several boxes go on one docket
  fields: { credentials: ["accessToken", "refreshToken"], options: ["clientId", "warehouseName", "senderEmail", "cargoMode", "deliveryPartnerId"] },
  help: "Shiprocket Cargo → Account Settings → Additional Settings → API Tokens: copy the Client ID, then Generate API token and copy the Access and Refresh tokens. Warehouse name = the name your pickup address gets in Cargo (it's created on the first booking). Delivery partner ID is optional (blank = the carrier Cargo assigns).",
  base: (acc) => (acc.baseUrl || "https://api-cargo.shiprocket.in").replace(/\/$/, ""),
  async token(acc) {
    if (acc.token && acc.tokenExpires > new Date()) return acc.token;
    need(acc, ["accessToken", "refreshToken"]);
    const { status, data } = await request(`${this.base(acc)}/api/token/refresh/`, {
      method: "POST",
      headers: { authorization: `Bearer ${acc.credentials.accessToken}` },
      json: { refresh: acc.credentials.refreshToken },
      timeout: 20000,
    });
    if (!data.access) throw new Error(`Shiprocket Cargo login failed (${status}): ${cargoErr(data) || "check the access and refresh tokens"}`);
    acc.token = data.access;
    acc.tokenExpires = new Date(Date.now() + 20 * 3600000); // valid a day
    await acc.save();
    return acc.token;
  },
  async call(acc, path, opts = {}) {
    const tok = await this.token(acc);
    const res = await request(`${this.base(acc)}${path}`, { timeout: 40000, ...opts, headers: { authorization: `Bearer ${tok}` } });
    if (res.status === 401) {
      acc.tokenExpires = new Date(0);
      await acc.save().catch(() => {});
      throw new Error("Shiprocket Cargo session expired; try again");
    }
    return res;
  },
  clientId(acc) {
    const id = parseInt(acc.options?.clientId, 10);
    if (!id) throw new Error(`${acc.name}: add the Client ID (Cargo → API Tokens) in Shopify Settings → Couriers`);
    return id;
  },
  packages(s) {
    const list = s.packages?.length ? s.packages : [{ weight: s.weight, length: s.length, breadth: s.breadth, height: s.height }];
    return list.map((p) => ({ units: 1, weight: r2(Math.max(0.1, Number(p.weight) || 0.5)), length: r2(Number(p.length) || 10), height: r2(Number(p.height) || 10), width: r2(Number(p.breadth) || 10), unit: "cm" }));
  },
  async book(acc, s, manual = {}) {
    pickupOk(acc);
    const client_id = this.clientId(acc);
    const p = acc.pickup || {};
    const pk = this.packages(s);
    const value = Math.max(1, r2(s.value));
    const eway = String(manual.ewayBill || "").replace(/\s/g, "");
    if (value > 50000 && !eway) throw new Error(`Shiprocket Cargo needs an e-way bill number for invoices above ₹50,000 (this one is ₹${value}) — enter it in the booking box`);
    const senderEmail = cargoEmail(acc.options?.senderEmail) || cargoEmail(p.email);
    if (!senderEmail) throw new Error(`${acc.name}: add the sender email in Shopify Settings → Couriers`);
    const c = s.consignee;
    const today = ymd(new Date());
    const invNo = String(s.invoiceNumber || s.reference).slice(0, 20);
    const mode = String(acc.options?.cargoMode || "surface").toLowerCase();
    const o = await this.call(acc, "/api/external/order_creation/", {
      method: "POST",
      json: {
        client_id,
        client_order_id: s.reference,
        no_of_packages: pk.length,
        approx_weight: r2(pk.reduce((t, x) => t + x.weight, 0)),
        invoice_value: value,
        invoice_number: invNo,
        invoice_date: today,
        is_insured: false,
        is_to_pay: false,
        to_pay_amount: null,
        is_cod: !!s.cod,
        ...(s.cod ? { cod_amount: r2(s.codAmount) } : {}),
        mode_name: mode,
        source_warehouse_name: String(acc.options?.warehouseName || p.name || s.seller.name).slice(0, 50),
        source_address_line1: String(p.address).slice(0, 200),
        source_address_line2: "",
        source_pincode: String(p.pincode),
        source_city: p.city || "",
        source_state: stateName(p.state),
        sender_contact_person_name: p.name || s.seller.name,
        sender_contact_person_email: senderEmail,
        sender_contact_person_contact_no: phone10(p.phone),
        destination_warehouse_name: `${c.name} ${s.reference}`.slice(0, 50),
        destination_address_line1: c.address1,
        destination_address_line2: c.address2 || "",
        destination_pincode: c.pincode,
        destination_city: c.city,
        destination_state: c.stateName,
        recipient_contact_person_name: c.name,
        recipient_contact_person_email: cargoEmail(c.email) || senderEmail,
        recipient_contact_person_contact_no: c.phone,
        packaging_unit_details: pk,
        channel_partner: null,
        po_no: null,
        po_expiry_date: null,
        is_appointment_taken: false,
        source: "API",
      },
    });
    const od = o.data || {};
    if (!od.order_id) throw new Error(`Shiprocket Cargo didn't create the order (${o.status}): ${cargoErr(od)}`);
    // The carrier: the one chosen in the booking box ("partnerId:modeId"), else the account's, else Cargo's pick.
    const list = od.carrier_list || [];
    const [wantDp, wantMode] = String(manual.courierId || acc.options?.deliveryPartnerId || "").split(":");
    const hit =
      (wantDp && list.find((x) => String(x.delivery_partner_id) === wantDp && (!wantMode || String(x.mode_id) === wantMode))) ||
      (od.delivery_partner_id ? { delivery_partner_id: od.delivery_partner_id, mode_id: od.mode_id, delivery_partner_name: od.delivery_partner_name } : list[0]);
    if (!hit) throw new Error(`Shiprocket Cargo created order ${od.order_id} but no carrier serves ${c.pincode}`);
    if (wantDp && String(hit.delivery_partner_id) !== wantDp) throw new Error(`Shiprocket Cargo order ${od.order_id}: delivery partner ${wantDp} isn't offered for this route`);
    const pickupAt = od.scheduled_pickup_date ? `${od.scheduled_pickup_date} 11:00:00` : `${today} 15:00:00`;
    const refs = { orderId: od.order_id, deliveryPartnerId: hit.delivery_partner_id, modeId: hit.mode_id, transporterId: hit.transportar_id || od.transportar_id || "" };
    const a = await this.call(acc, "/api/order_shipment_association/", {
      method: "POST",
      json: {
        client_id,
        order_id: od.order_id,
        remarks: `Order ${s.reference}`,
        recipient_GST: null,
        mode_id: hit.mode_id,
        delivery_partner_id: hit.delivery_partner_id,
        ...(eway ? { eway_bill_no: eway } : {}),
        invoice_value: value,
        invoice_number: invNo,
        invoice_date: today,
        pickup_date_time: pickupAt,
        ...(s.cod ? { cod_amount: r2(s.codAmount) } : {}),
        source: "API",
      },
    });
    const sd = a.data || {};
    if (!sd.id) throw new Error(`Shiprocket Cargo created order ${od.order_id} but didn't book it (${a.status}): ${cargoErr(sd)}`);
    refs.shipmentId = sd.id;
    let awb = sd.waybill_no || "";
    let labelUrl = sd.label_url || "";
    // Async accounts: the docket number comes a little later.
    for (const wait of [5000, 10000, 15000]) {
      if (awb) break;
      await new Promise((r) => setTimeout(r, wait));
      const g = await this.call(acc, `/api/external/get_shipment/${sd.id}`).catch(() => null);
      awb = g?.data?.waybill_no || "";
      labelUrl = g?.data?.label_url || labelUrl;
    }
    if (sd.child_waybill_nos?.length) refs.childAwbs = sd.child_waybill_nos;
    const courierName = `Shiprocket Cargo · ${hit.delivery_partner_name || sd.delivery_partner?.name || "carrier"}`;
    if (!awb) {
      // Booked: the docket number is fetched on the next tracking update.
      refs.awbPending = true;
      return { awb: `CARGO-${sd.id}`, courierName, labelUrl, trackingUrl: "", refs };
    }
    return { awb: String(awb), courierName, labelUrl, trackingUrl: CARGO_TRACK(awb), refs };
  },
  async track(acc, sh) {
    let awb = sh.awb;
    let extra = {};
    if (sh.refs?.awbPending || /^CARGO-/.test(awb)) {
      const { data } = await this.call(acc, `/api/external/get_shipment/${sh.refs?.shipmentId || awb.replace(/^CARGO-/, "")}`);
      if (!data?.waybill_no) return { status: "pending", text: data?.status || "Booked — waiting for the docket number", events: [] };
      awb = String(data.waybill_no);
      extra = { awb, labelUrl: data.label_url || "", trackingUrl: CARGO_TRACK(awb), refs: { ...(sh.refs || {}), awbPending: false } };
    }
    const { status, data } = await this.call(acc, `/api/shipment/track/${encodeURIComponent(awb)}/`);
    if (status === 404) return { status: "pending", text: "Not scanned yet", events: [], ...extra };
    const d = Array.isArray(data) ? data[0] || {} : data || {};
    const cur = d.status || "";
    const map = /^(undelivered|rto)/i.test(cur) ? "rto" : /^(lost|damaged|destroyed|disposed off|failed)$/i.test(cur) ? "cancelled" : normStatus(cur);
    const events = (d.status_history || []).map((e) => ({ at: new Date(e.timestamp || e.added_at), status: e.status + (e.remarks ? ` — ${e.remarks}` : ""), location: e.location || "" }));
    return { status: /^undelivered$/i.test(cur) ? "in_transit" : map, text: cur, events, ...extra };
  },
  async label(acc, sh) {
    if (sh.labelUrl) return { url: sh.labelUrl };
    if (!sh.refs?.shipmentId) return null;
    const { data } = await this.call(acc, `/api/external/get_shipment/${sh.refs.shipmentId}`);
    return data?.label_url ? { url: data.label_url } : null;
  },
  async cancel() {
    throw new Error("Shiprocket Cargo's API can't cancel a docket — cancel it in the Cargo dashboard (app-cargo.shiprocket.in), then mark it cancelled here");
  },
};

/* ---------------- Velocity Shipping (shazam.velocity.in) ---------------- */
// Two steps: forward-order (creates the order at the warehouse) then forward-order-shipment (assigns the courier:
// the one chosen in the booking box, the account's, or Velocity's shipping rules) → AWB + label.
const velErr = (d) => (d && typeof d === "object" ? d.message || d.error || d.errors || d.payload?.message || d : d);
const velocity = {
  title: "Velocity Shipping",
  fields: { credentials: ["apiKey"], options: ["warehouseId", "pickupLocation", "carrierId"] },
  help: "Velocity dashboard → Settings → API Keys → Generate API Key (up to 365 days; shown once). Warehouse ID and pickup location name are on your warehouse in Velocity. Carrier ID is optional (blank = your Velocity shipping rules).",
  base: (acc) => (acc.baseUrl || "https://shazam.velocity.in").replace(/\/$/, ""),
  async call(acc, path, json) {
    need(acc, ["apiKey"]);
    const key = String(acc.credentials.apiKey).replace(/^Bearer\s+/i, "");
    const res = await request(`${this.base(acc)}/custom/api/v1${path}`, { method: "POST", headers: { authorization: `Bearer ${key}` }, json, timeout: 40000 });
    if (res.status === 401) throw new Error("Velocity rejected the API key — generate a new one (Settings → API Keys) and save it here");
    return res;
  },
  // A light call to check the key (Couriers → Save).
  async token(acc) {
    const { status, data } = await this.call(acc, "/serviceability", { from: acc.pickup?.pincode || "110001", to: "110001", payment_mode: "prepaid", shipment_type: "forward" });
    if (status >= 400) throw new Error(`Velocity: ${short(velErr(data))}`);
    return "ok";
  },
  async book(acc, s, manual = {}) {
    need2(acc, ["warehouseId", "pickupLocation"]);
    const c = s.consignee;
    const at = new Date(s.orderDate.getTime() + 5.5 * 3600000).toISOString();
    const o = await this.call(acc, "/forward-order", {
      order_id: s.reference,
      order_date: `${at.slice(0, 10)} ${at.slice(11, 16)}`,
      billing_customer_name: c.name,
      billing_last_name: "",
      billing_address: [c.address1, c.address2].filter(Boolean).join(", "),
      billing_city: c.city,
      billing_pincode: c.pincode,
      billing_state: c.stateName,
      billing_country: "India",
      billing_email: c.email || "",
      billing_phone: c.phone,
      shipping_is_billing: true,
      print_label: true,
      order_items: s.items.map((i) => ({ name: i.name, sku: i.sku || i.name.slice(0, 40), units: i.quantity, selling_price: r2(i.price), hsn: i.hsn || "" })),
      payment_method: s.cod ? "COD" : "PREPAID",
      sub_total: r2(s.value),
      cod_collectible: s.cod ? r2(s.codAmount) : 0,
      shipping_charges: 0,
      length: s.length,
      breadth: s.breadth,
      height: s.height,
      weight: s.weight,
      pickup_location: acc.options.pickupLocation,
      warehouse_id: acc.options.warehouseId,
    });
    const p1 = o.data?.payload || {};
    if (o.status >= 400 || !p1.shipment_id) throw new Error(`Velocity didn't create the order (${o.status}): ${short(velErr(o.data))}`);
    const refs = { orderId: p1.order_id, shipmentId: p1.shipment_id };
    // Courier auto-assignment on the account may already have given the AWB.
    if (p1.awb_code) return { awb: String(p1.awb_code), courierName: p1.courier_name || "Velocity", labelUrl: p1.label_url || "", refs };
    const a = await this.call(acc, "/forward-order-shipment", { shipment_id: p1.shipment_id, carrier_id: String(manual.courierId || acc.options.carrierId || "") });
    const p2 = a.data?.payload || {};
    if (!p2.awb_code) throw new Error(`Velocity created order ${p1.order_id} but couldn't assign a courier: ${short(velErr(a.data))}`);
    return { awb: String(p2.awb_code), courierName: p2.courier_name || "Velocity", labelUrl: p2.label_url || "", refs };
  },
  async track(acc, sh) {
    const { status, data } = await this.call(acc, "/order-tracking", { awbs: [sh.awb] });
    if (status >= 400) throw new Error(short(velErr(data)));
    const td = data.result?.[sh.awb]?.tracking_data || Object.values(data.result || {})[0]?.tracking_data || {};
    const cur = td.shipment_status || td.shipment_track?.[0]?.current_status || "";
    const events = (td.shipment_track_activities || []).map((e) => ({ at: new Date(String(e.date).replace(" ", "T") + "+05:30"), status: e.activity, location: e.location || "" }));
    return { status: normStatus(String(cur).replace(/_/g, " ")), text: cur, events, ...(td.track_url ? { trackingUrl: td.track_url } : {}) };
  },
  async label(acc, sh) {
    return sh.labelUrl ? { url: sh.labelUrl } : null;
  },
  async cancel(acc, sh) {
    const { status, data } = await this.call(acc, "/cancel-order", { awbs: [sh.awb] });
    if (status >= 400) throw new Error(short(velErr(data)));
  },
};

const CARRIERS = { shiprocket, shiprocket_cargo, velocity, delhivery, bluedart, dtdc, shadowfax, custom };

// Amount to collect on delivery: all of a COD order, the unpaid part of a partly paid one.
function codOf(order) {
  if (order.paymentMode === "prepaid") return 0;
  if (order.codAmount > 0) return r2(order.codAmount);
  return order.paymentMode === "cod" ? r2(order.outstanding > 0 ? order.outstanding : order.total) : 0;
}

// The courier's order reference: the order number, plus -2, -3… after earlier bookings were cancelled.
function refOf(order) {
  const base = String(order.name || order.orderNumber).replace(/^#/, "");
  const cancelled = Math.max((order.cancelledShipments || []).length, (String(order.remarks || "").match(/Shipment .+ cancelled on/g) || []).length);
  return cancelled ? `${base}-${cancelled + 1}` : base;
}

// Everything a carrier needs, from a Shopify order.
function shipmentFrom(order, org, pkg, itemMap = new Map()) {
  const a = order.shippingAddress || {};
  const items = order.lines.filter((l) => l.quantity > 0).map((l) => ({ name: l.variantTitle ? `${l.title} - ${l.variantTitle}` : l.title, sku: l.sku, quantity: l.quantity, price: l.quantity ? r2(l.total / l.quantity) : 0, hsn: itemMap.get(String(l.item))?.hsnSac || l.hsn || "", taxRate: itemMap.get(String(l.item))?.taxRate ?? (l.shopifyTaxRate || 0), category: l.productType || "" }));
  const orgAddr = org.address || {};
  return {
    reference: refOf(order),
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

module.exports = { handedOver, CARRIERS, shipmentFrom, checkShipment, normStatus, stateName, codOf };
