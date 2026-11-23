// Book, track and cancel shipments for Shopify orders; optionally mark them fulfilled in Shopify.
const ShopifyOrder = require("../../models/ShopifyOrder");
const ShopifyStore = require("../../models/ShopifyStore");
const CourierAccount = require("../../models/CourierAccount");
const Organization = require("../../models/Organization");
const { CARRIERS, shipmentFrom, checkShipment, codOf } = require("../couriers");
const { gql } = require("./client");
const { resolvePackage } = require("./package");
const { quoteAccount } = require("../couriers/rates");

const STATUS_FROM_TRACK = {
  delivered: "delivered",
  rto: "rto",
  in_transit: "shipped",
  out_for_delivery: "shipped",
};

/* ---------------- COD / prepaid accounts ---------------- */
// Does this account take this kind of order? options.codEnabled === false: prepaid only; options.codOnly: COD only.
const takesPayment = (acc, cod) =>
  cod ? acc.options?.codEnabled !== false : !acc.options?.codOnly;
const isCodOrder = (order) => codOf(order) > 0;
// The account to book with: the one chosen if it takes this order's payment type, else the same courier's account
// that does (e.g. chose "Blue Dart Prepaid" for a COD order → "Blue Dart COD").
async function accountForPayment(acc, order) {
  const cod = isCodOrder(order);
  if (takesPayment(acc, cod)) return acc;
  const other = (
    await CourierAccount.find({
      organization: acc.organization,
      carrier: acc.carrier,
      active: true,
    })
  ).find((a) => String(a._id) !== String(acc._id) && takesPayment(a, cod));
  if (other) return other;
  throw new Error(
    `${acc.name} is for ${cod ? "prepaid" : "COD"} orders only, and there's no ${acc.carrier === "bluedart" ? "Blue Dart" : acc.name} account for ${cod ? "COD" : "prepaid"} orders — add one in Settings → Couriers, or choose another courier`,
  );
}

/* ---------------- what's left to ship ---------------- */

// Units not yet fulfilled in Shopify, read live (a seller may have shipped their products themselves): lineId → n.
// null when it can't be known (not a Shopify order, no store) — then everything counts.
async function unfulfilledMap(store, order) {
  if (
    !store?.connected ||
    (order.channel && order.channel !== "shopify") ||
    !String(order.shopifyId || "").startsWith("gid://shopify/Order/")
  )
    return null;
  try {
    const d = await gql(
      store,
      `query($id: ID!) { order(id: $id) { lineItems(first: 100) { nodes { id unfulfilledQuantity } } } }`,
      { id: order.shopifyId },
    );
    const nodes = d.order?.lineItems?.nodes;
    return nodes
      ? new Map(nodes.map((n) => [n.id, n.unfulfilledQuantity]))
      : null;
  } catch {
    return null;
  }
}
// Stored per line by the sync when the live answer isn't asked for.
const storedUnfulfilled = (order) =>
  (order.lines || []).some((l) => l.unfulfilled != null)
    ? new Map(order.lines.map((l) => [l.lineId, l.unfulfilled ?? l.quantity]))
    : null;

// The lines still to ship: [{ line, quantity }] and the units already fulfilled elsewhere.
function remaining(order, unf) {
  const live = (order.lines || []).filter((l) => l.quantity > 0);
  const rows = live.map((l) => ({
    line: l,
    quantity:
      unf && unf.has(l.lineId)
        ? Math.max(0, Math.min(l.quantity, unf.get(l.lineId)))
        : l.quantity,
  }));
  return {
    rows: rows.filter((r) => r.quantity > 0),
    done: rows
      .filter((r) => r.quantity < r.line.quantity)
      .map((r) => ({
        lineId: r.line.lineId,
        title: r.line.variantTitle
          ? `${r.line.title} - ${r.line.variantTitle}`
          : r.line.title,
        sku: r.line.sku || "",
        quantity: r.line.quantity - r.quantity,
      })),
  };
}

// COD for only part of the order: the COD in proportion to the value still to ship (the rest went with the other shipment).
function codShare(order, rows) {
  const full = (order.lines || [])
    .filter((l) => l.quantity > 0)
    .reduce((t, l) => t + (l.total || 0), 0);
  const part = rows.reduce(
    (t, r) =>
      t + (r.line.quantity ? (r.line.total / r.line.quantity) * r.quantity : 0),
    0,
  );
  const cod = codOf(order);
  return full > 0 ? Math.round(((cod * part) / full) * 100) / 100 : cod;
}

// The order as it's left to ship: only the units not yet fulfilled (the whole order when nothing went yet).
function shippableView(order, unf) {
  const left = remaining(order, unf);
  if (!left.done.length) return order;
  return boxOrder(
    order,
    {
      lines: left.rows.map((r) => ({
        lineId: String(r.line.lineId),
        quantity: r.quantity,
        unit: r.line.quantity ? r.line.total / r.line.quantity : 0,
      })),
    },
    codShare(order, left.rows),
  );
}

// Save a booking. The order may have been changed meanwhile (the 15-minute sync saved it), which makes a normal
// save fail on its version — after the courier already made the AWBs. Then write just these fields directly, so a
// booked shipment is never lost.
async function saveBooking(order, paths) {
  try {
    await order.save();
  } catch (e) {
    if (!(
      e.name === "VersionError" || /No matching document/i.test(e.message || "")
    ))
      throw e;
    const plain = (v) =>
      v && typeof v.toObject === "function"
        ? v.toObject()
        : Array.isArray(v)
          ? v.map(plain)
          : v;
    const $set = {};
    const $unset = {};
    for (const p of paths) {
      const v = order.get(p);
      if (v === undefined) $unset[p] = 1;
      else $set[p] = plain(v);
    }
    await ShopifyOrder.updateOne(
      { _id: order._id },
      {
        ...(Object.keys($set).length ? { $set } : {}),
        ...(Object.keys($unset).length ? { $unset } : {}),
        $inc: { __v: 1 }, // a sync holding the old copy then fails instead of writing over the booking
      },
    );
  }
}

/* ---------------- several boxes ---------------- */

// Validate a box split → [{ lines: [{ lineId, title, sku, quantity, unit }], pkg }] or null for one box of everything.
function splitBoxes(order, boxes, avail = null) {
  if (!Array.isArray(boxes) || !boxes.length) return null;
  const live = (order.lines || [])
    .filter((l) => l.quantity > 0)
    .map((l) =>
      avail && avail.has(l.lineId)
        ? {
            ...(l.toObject ? l.toObject() : l),
            quantity: Math.max(0, Math.min(l.quantity, avail.get(l.lineId))),
            total: l.quantity
              ? (l.total / l.quantity) *
                Math.max(0, Math.min(l.quantity, avail.get(l.lineId)))
              : 0,
          }
        : l,
    )
    .filter((l) => l.quantity > 0);
  const partial =
    avail &&
    (order.lines || []).some(
      (l) =>
        l.quantity > 0 &&
        avail.has(l.lineId) &&
        avail.get(l.lineId) < l.quantity,
    );
  const byId = new Map(live.map((l) => [String(l.lineId), l]));
  const used = new Map();
  const out = boxes
    .map((b) => ({
      pkg: b.pkg || {},
      lines: (b.lines || [])
        .filter((x) => Number(x.quantity) > 0)
        .map((x) => {
          const l = byId.get(String(x.lineId));
          if (!l) {
            const was = (order.lines || []).find(
              (o) => String(o.lineId) === String(x.lineId) && o.quantity > 0,
            );
            throw new Error(
              was
                ? `${was.title} is already fulfilled in Shopify — leave it out of the boxes`
                : "A box has a product that isn't on this order",
            );
          }
          // One unit packed in several boxes: each box holds part `part` of `of` (counts as 1/of of a unit).
          const of = Number(x.of) > 1 ? Number(x.of) : 1;
          const part =
            of > 1 ? Math.min(of, Math.max(1, Number(x.part) || 1)) : 1;
          if (of > 1 && Number(x.quantity) !== 1)
            throw new Error(
              "A product split over several boxes is one unit per part",
            );
          used.set(
            String(x.lineId),
            (used.get(String(x.lineId)) || 0) + Number(x.quantity) / of,
          );
          const title = l.variantTitle
            ? `${l.title} - ${l.variantTitle}`
            : l.title;
          return {
            lineId: String(l.lineId),
            title: of > 1 ? `${title} (part ${part} of ${of})` : title,
            sku: l.sku || "",
            quantity: Number(x.quantity),
            unit: l.quantity ? l.total / l.quantity : 0,
            ...(of > 1 ? { part, of } : {}),
          };
        }),
    }))
    .filter((b) => b.lines.length);
  for (const l of live) {
    const n = used.get(String(l.lineId)) || 0;
    if (Math.abs(n - l.quantity) > 1e-6)
      throw new Error(
        `${l.title}: ${Math.round(n * 100) / 100} of ${l.quantity} put in boxes — every unit (or every part of a unit packed in several boxes) must be in exactly one box`,
      );
  }
  // A box holding part of a split item: its package type would be the whole item's, so its size must be entered.
  out.forEach((b, i) => {
    const pk = b.pkg || {};
    if (
      b.lines.some((l) => l.of > 1) &&
      !["weight", "length", "breadth", "height"].every((k) => Number(pk[k]) > 0)
    )
      throw new Error(
        `Box ${i + 1} holds part of an item packed in several boxes — enter its weight and size`,
      );
  });
  if (out.length === 1 && !partial) return null; // everything in one box: the usual booking
  if (out.length > 20) throw new Error("Up to 20 boxes per order");
  return out;
}

// The order as one box sees it: only its products, its value and its share of the COD.
function boxOrder(order, box, cod) {
  const o =
    typeof order.toObject === "function" ? order.toObject() : { ...order };
  const lines = box.lines.map((b) => {
    const l = (o.lines || []).find((x) => String(x.lineId) === b.lineId) || {};
    return {
      ...l,
      quantity: b.quantity,
      total: Math.round(((b.unit * b.quantity) / (b.of || 1)) * 100) / 100,
    };
  });
  const total =
    Math.round(lines.reduce((t, l) => t + (l.total || 0), 0) * 100) / 100;
  return {
    ...o,
    lines,
    total,
    codAmount: cod,
    outstanding: cod,
    paymentMode: cod > 0 ? (cod < total ? "partial" : "cod") : "prepaid",
    prepaidAmount: Math.max(0, total - cod),
  };
}

async function bookBoxes({
  ctx,
  order,
  acc,
  seller,
  store,
  org,
  items,
  boxes,
  manual,
  skipCheck,
  cod = null,
}) {
  const n = boxes.length;
  // COD shared by value; the last box takes the paise left over.
  const codTotal = cod ?? codOf(order);
  const values = boxes.map((b) =>
    b.lines.reduce((t, l) => t + (l.unit * l.quantity) / (l.of || 1), 0),
  );
  const sumV = values.reduce((t, v) => t + v, 0) || 1;
  let left = codTotal;
  const cods = values.map((v, i) => {
    if (i === n - 1) return Math.round(left * 100) / 100;
    const c = Math.round(((codTotal * v) / sumV) * 100) / 100;
    left -= c;
    return c;
  });
  const base = shipmentFrom(order, org, { weight: 1 }, items).reference;
  const booked = [];
  const problems = [];
  for (let i = 0; i < n; i++) {
    const b = boxes[i];
    const view = boxOrder(order, b, cods[i]);
    try {
      const p = await resolvePackage(
        view,
        b.pkg,
        ctx.storeOrg || ctx.org,
        items,
      );
      if (!p)
        throw new Error(
          "no package type for its products — enter its weight and size",
        );
      const s = shipmentFrom(view, org, p, items);
      s.reference = i === 0 ? base : `${base}-B${i + 1}`;
      if (acc.carrier !== "custom") checkShipment(s);
      if (s.cod && acc.options?.codEnabled === false)
        throw new Error(`${acc.name} isn't set up for COD`);
      const q = await quoteAccount(acc, s);
      if (q.serviceable === false && !skipCheck)
        throw new Error(`not serviceable: ${q.note || s.consignee.pincode}`);
      const out = await CARRIERS[acc.carrier].book(
        acc,
        s,
        manual.awbs?.[i] ? { ...manual, awb: manual.awbs[i] } : manual,
      );
      const sh = {
        account: acc._id,
        carrier: acc.carrier,
        courierName: out.courierName,
        awb: out.awb,
        labelUrl: out.labelUrl || "",
        trackingUrl:
          out.trackingUrl ||
          (acc.trackingUrl ? acc.trackingUrl.replace("{awb}", out.awb) : ""),
        refs: out.refs || {},
        weight: s.weight,
        length: s.length,
        breadth: s.breadth,
        height: s.height,
        packageName: p.packageName || "",
        charge: q.charge ?? undefined,
        chargeSource: q.charge != null ? q.source : "",
        codAmount: s.cod ? s.codAmount : 0,
        bookedAt: new Date(),
        trackStatus: "pending",
        events: [],
        box: i + 1,
        of: n,
        lines: b.lines.map(({ lineId, title, sku, quantity, part, of }) => ({
          lineId,
          title,
          sku,
          quantity,
          ...(of ? { part, of } : {}),
        })),
        ...(seller
          ? {
              seller: seller._id,
              pickup: {
                ...acc.pickup,
                seller: String(seller._id),
                sellerName: seller.name,
              },
            }
          : {}),
      };
      if (out.labelPdf) sh.labelPdf = out.labelPdf;
      if (
        store?.fulfillInShopify &&
        (!order.channel || order.channel === "shopify")
      ) {
        try {
          // A unit packed in several boxes is fulfilled once, with the box holding its part 1.
          const fl = sh.lines.filter((l) => !(l.part > 1));
          sh.shopifyFulfilled = fl.length
            ? await fulfillInShopify(store, order, sh, fl)
            : false;
        } catch (e) {
          problems.push(
            `Box ${i + 1}: booked, but not marked fulfilled in Shopify (${e.message})`,
          );
        }
      }
      if (out.refs?.pickupError)
        problems.push(
          `Box ${i + 1}: pickup not registered (${out.refs.pickupError})`,
        );
      booked.push(sh);
    } catch (e) {
      problems.push(`Box ${i + 1} not booked: ${e.message}`);
      if (i === 0) break; // nothing booked yet: stop here
    }
  }
  if (!booked.length) throw new Error(problems.join(" · "));
  order.shipment = booked[0];
  order.extraShipments = booked.length > 1 ? booked.slice(1) : undefined;
  order.boxes = boxes.map((b, i) => ({
    box: i + 1,
    lines: b.lines.map(({ lineId, title, sku, quantity, part, of }) => ({
      lineId,
      title,
      sku,
      quantity,
      ...(of ? { part, of } : {}),
    })),
    booked: booked.some((x) => x.box === i + 1),
  }));
  order.status = "ready_to_ship";
  order.statusChangedAt = new Date();
  order.markModified("shipment");
  order.markModified("extraShipments");
  order.markModified("boxes");
  await saveBooking(order, [
    "shipment",
    "extraShipments",
    "boxes",
    "status",
    "statusChangedAt",
  ]);
  return {
    awb: booked.map((x) => x.awb).join(", "),
    courierName: booked[0].courierName,
    boxes: booked.length,
    of: n,
    charge: booked.reduce((t, x) => t + (x.charge || 0), 0) || null,
    warning: problems.join(" · "),
  };
}

// One label view per box of a several-box (or partly shipped) order: only that box's products and COD.
// Box 1 booked before its lines/COD were kept: its products are the ones not in the other boxes, its COD the rest.
function boxViews(order) {
  const o = typeof order.toObject === "function" ? order.toObject() : order;
  const ships = allShipments(o);
  if (!(o.extraShipments || []).length && !(o.shipment?.lines || []).length)
    return null;
  const unitOf = (lineId) => {
    const l = (o.lines || []).find((x) => String(x.lineId) === String(lineId));
    return l?.quantity ? l.total / l.quantity : 0;
  };
  const extras = o.extraShipments || [];
  const of = ships.length;
  return ships.map((x, i) => {
    let lines = x.lines || [];
    let cod = x.codAmount;
    if (i === 0 && !lines.length) {
      const inOthers = new Map();
      for (const e of extras)
        for (const l of e.lines || [])
          inOthers.set(
            String(l.lineId),
            (inOthers.get(String(l.lineId)) || 0) + l.quantity / (l.of || 1),
          );
      lines = (o.lines || [])
        .filter((l) => l.quantity > 0)
        .map((l) => ({
          lineId: String(l.lineId),
          title: l.title,
          sku: l.sku,
          quantity: Math.round(
            l.quantity - (inOthers.get(String(l.lineId)) || 0),
          ),
        }))
        .filter((l) => l.quantity > 0);
    }
    if (i === 0 && cod == null)
      cod = Math.max(
        0,
        Math.round(
          (codOf(o) - extras.reduce((t, e) => t + (e.codAmount || 0), 0)) * 100,
        ) / 100,
      );
    const n = x.of || of;
    return {
      ...boxOrder(
        o,
        { lines: lines.map((l) => ({ ...l, unit: unitOf(l.lineId) })) },
        cod || 0,
      ),
      shipment: x,
      name: n > 1 ? `${o.name} box ${x.box || i + 1}/${n}` : o.name,
    };
  });
}

// Every shipment of an order: box 1 (`shipment`) and the other boxes.
const allShipments = (order) =>
  [order.shipment, ...(order.extraShipments || [])].filter((x) => x?.awb);

async function fulfillInShopify(store, order, sh, lines = null) {
  if (lines?.length) return fulfillLines(store, order, sh, lines);
  const data = await gql(
    store,
    `query($id: ID!) { order(id: $id) { fulfillmentOrders(first: 10) { nodes { id status } } } }`,
    { id: order.shopifyId },
  );
  const open = (data.order?.fulfillmentOrders?.nodes || []).filter((f) =>
    ["OPEN", "IN_PROGRESS", "SCHEDULED"].includes(f.status),
  );
  if (!open.length) return false;
  const res = await gql(
    store,
    `mutation($f: FulfillmentInput!) { fulfillmentCreate(fulfillment: $f) { fulfillment { id status } userErrors { field message } } }`,
    {
      f: {
        lineItemsByFulfillmentOrder: open.map((f) => ({
          fulfillmentOrderId: f.id,
        })),
        notifyCustomer: store.notifyCustomer !== false,
        trackingInfo: {
          company: sh.courierName,
          number: sh.awb,
          ...(sh.trackingUrl ? { url: sh.trackingUrl } : {}),
        },
      },
    },
  );
  const errs = res.fulfillmentCreate?.userErrors || [];
  if (errs.length) throw new Error(errs.map((e) => e.message).join("; "));
  return true;
}

// Fulfil only some products (one box): their quantities, from whichever fulfilment orders still hold them.
async function fulfillLines(store, order, sh, lines) {
  const data = await gql(
    store,
    `query($id: ID!) { order(id: $id) { fulfillmentOrders(first: 10) { nodes { id status lineItems(first: 50) { nodes { id remainingQuantity lineItem { id } } } } } } }`,
    { id: order.shopifyId },
  );
  const open = (data.order?.fulfillmentOrders?.nodes || []).filter((f) =>
    ["OPEN", "IN_PROGRESS", "SCHEDULED"].includes(f.status),
  );
  const byFo = new Map();
  for (const l of lines) {
    let need = l.quantity;
    for (const fo of open)
      for (const li of fo.lineItems?.nodes || []) {
        if (
          need <= 0 ||
          li.lineItem?.id !== l.lineId ||
          li.remainingQuantity <= 0
        )
          continue;
        const q = Math.min(need, li.remainingQuantity);
        li.remainingQuantity -= q;
        need -= q;
        if (!byFo.has(fo.id)) byFo.set(fo.id, []);
        byFo.get(fo.id).push({ id: li.id, quantity: q });
      }
  }
  if (!byFo.size) return false;
  const res = await gql(
    store,
    `mutation($f: FulfillmentInput!) { fulfillmentCreate(fulfillment: $f) { fulfillment { id status } userErrors { field message } } }`,
    {
      f: {
        lineItemsByFulfillmentOrder: [...byFo].map(
          ([fulfillmentOrderId, fulfillmentOrderLineItems]) => ({
            fulfillmentOrderId,
            fulfillmentOrderLineItems,
          }),
        ),
        notifyCustomer: store.notifyCustomer !== false,
        trackingInfo: {
          company: sh.courierName,
          number: sh.awb,
          ...(sh.trackingUrl ? { url: sh.trackingUrl } : {}),
        },
      },
    },
  );
  const errs = res.fulfillmentCreate?.userErrors || [];
  if (errs.length) throw new Error(errs.map((e) => e.message).join("; "));
  return true;
}

// boxes: ship in several boxes, each booked with its own AWB — [{ lines: [{ lineId, quantity }], pkg }].
// One box holding everything (or no boxes) is the usual single booking.
async function bookOrder(
  ctx,
  order,
  {
    accountId,
    pkg = {},
    manual = {},
    skipCheck = false,
    pickupFrom = "",
    boxes = null,
  },
) {
  if (order.status === "cancelled") throw new Error("Order is cancelled");
  if (order.channel === "amazon" && order.amazon?.easyShip)
    throw new Error(
      "Amazon Easy Ship order: Amazon picks it up — use Schedule Easy Ship pickup",
    );
  if (order.channel === "flipkart" && order.flipkart?.selfShip === false)
    throw new Error(
      "Flipkart's courier picks this one up: use Pack & label, then Ready to Dispatch",
    );
  if (
    order.shipment?.awb &&
    order.status !== "new" &&
    order.status !== "packed"
  )
    throw new Error(
      `Already booked: ${order.shipment.courierName} ${order.shipment.awb}`,
    );
  let realAcc = await CourierAccount.findOne({
    _id: accountId,
    organization: ctx.storeOrg || ctx.org,
    active: true,
  });
  if (!realAcc) throw new Error("Choose a courier");
  // COD and prepaid can have their own account with a courier (Blue Dart has separate customer codes): a COD
  // order goes to the COD account, a prepaid one to the prepaid account, whichever of the two was chosen.
  realAcc = await accountForPayment(realAcc, order);
  // Tell the sync a booking is under way, so it doesn't mark the order shipped from the fulfilments we're making.
  if (order._id)
    await ShopifyOrder.updateOne(
      { _id: order._id },
      { $set: { bookingAt: new Date() } },
    ).catch(() => {});
  // An earlier AWB still on the order (the courier cancelled it): clear it and its Shopify fulfilment first,
  // so Shopify gets the new AWB.
  if (order.shipment?.awb) {
    for (const old of allShipments(order)) {
      const note =
        order.channel && order.channel !== "shopify"
          ? ""
          : await cancelInShopify(order, old.awb, old);
      order.cancelledShipments = [
        ...(order.cancelledShipments || []),
        { courier: old.courierName || "", awb: old.awb, at: new Date() },
      ];
      order.remarks = `${order.remarks ? `${order.remarks}\n` : ""}Shipment ${`${old.courierName || ""} ${old.awb}`.trim()} replaced on ${new Date().toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" })}${note ? ` · ${note}` : ""}`;
    }
    order.shipment = {};
    order.extraShipments = undefined;
    order.boxes = undefined;
    await saveBooking(order, [
      "shipment",
      "extraShipments",
      "boxes",
      "cancelledShipments",
      "remarks",
    ]);
  }
  // Marketplace seller's products: picked up from the seller's address (registered with the courier if it keeps pickup locations).
  const sellers = require("../sellers");
  // Only what's still to ship decides it: a seller's products already fulfilled in Shopify don't count.
  const store = await ShopifyStore.findOne({
    organization: ctx.storeOrg || ctx.org,
  });
  const unf = await unfulfilledMap(store, order);
  const left = remaining(order, unf);
  if (unf && !left.rows.length)
    throw new Error(
      "Everything on this order is already fulfilled in Shopify — nothing left to book",
    );
  const seller = await sellers.pickupFor(
    ctx.storeOrg || ctx.org,
    {
      name: order.name,
      lines: left.rows.map((r) => ({
        ...(r.line.toObject ? r.line.toObject() : r.line),
        quantity: r.quantity,
      })),
    },
    pickupFrom,
  );
  if (seller) {
    const miss = sellers.pickupProblems(seller);
    if (miss.length)
      throw new Error(
        `${seller.name}'s pickup address is missing ${miss.join(", ")} (Store → Sellers)`,
      );
    if (
      ["shiprocket", "delhivery"].includes(realAcc.carrier) &&
      !(seller.couriers || {})[String(realAcc._id)]?.pickupLocation
    )
      await sellers.registerPickup(seller, realAcc);
  }
  const acc = sellers.withPickup(realAcc, seller);
  const org = await Organization.findById(ctx.org);
  // HSN and GST from the (checked) OrdexaGo items, not Shopify's.
  const Item = require("../../models/Item");
  const items = new Map(
    (
      await Item.find({
        _id: { $in: order.lines.map((l) => l.item).filter(Boolean) },
      }).lean()
    ).map((i) => [String(i._id), i]),
  );
  // Products already fulfilled in Shopify (e.g. a seller shipped theirs) aren't booked again.
  if (unf && left.done.length && !(boxes || []).length)
    boxes = [
      {
        lines: left.rows.map((r) => ({
          lineId: r.line.lineId,
          quantity: r.quantity,
        })),
        pkg,
      },
    ];
  const split = splitBoxes(order, boxes, unf);
  if (split)
    return bookBoxes({
      ctx,
      order,
      acc,
      seller,
      store,
      org,
      items,
      boxes: split,
      manual,
      skipCheck,
      cod: left.done.length ? codShare(order, left.rows) : null,
    });
  // Package: chosen / typed in, else from the products' package types.
  const p = await resolvePackage(order, pkg, ctx.storeOrg || ctx.org, items);
  if (!p)
    throw new Error(
      "Its products have no package type — choose a package or enter the weight and size",
    );
  const s = shipmentFrom(order, org, p, items);
  if (acc.carrier !== "custom") checkShipment(s);
  if (s.cod && acc.options?.codEnabled === false)
    throw new Error(
      `${acc.name} isn't set up for COD; choose another courier for this ₹${s.codAmount} COD order`,
    );
  // Live pincode check: book only where the courier delivers.
  const q = await quoteAccount(acc, s);
  let charge = q.charge;
  let chargeSource = q.source;
  if (manual.courierId && q.options) {
    const opt = q.options.find((o) => o.courierId === String(manual.courierId));
    if (!opt && !skipCheck)
      throw new Error(
        `${acc.name}: that courier no longer serves ${s.consignee.pincode}; check the rates again`,
      );
    if (opt) [charge, chargeSource] = [opt.charge, "api"];
  } else if (q.serviceable === false && !skipCheck)
    throw new Error(
      `Not serviceable: ${q.note || `${acc.name} doesn't deliver to ${s.consignee.pincode}`}. Choose another courier.`,
    );
  const out = await CARRIERS[acc.carrier].book(acc, s, manual);
  order.shipment = {
    account: acc._id,
    carrier: acc.carrier,
    courierName: out.courierName,
    awb: out.awb,
    labelUrl: out.labelUrl || "",
    trackingUrl:
      out.trackingUrl ||
      (acc.trackingUrl ? acc.trackingUrl.replace("{awb}", out.awb) : ""),
    refs: out.refs || {},
    weight: s.weight,
    length: s.length,
    breadth: s.breadth,
    height: s.height,
    packageName: p.packageName || "",
    charge: charge ?? undefined,
    chargeSource: charge != null ? chargeSource : "",
    bookedAt: new Date(),
    trackStatus: "pending",
    events: [],
    ...(seller
      ? {
          seller: seller._id,
          pickup: {
            ...acc.pickup,
            seller: String(seller._id),
            sellerName: seller.name,
          },
        }
      : {}),
  };
  if (out.labelPdf) order.shipment.labelPdf = out.labelPdf;
  order.status = "ready_to_ship";
  order.statusChangedAt = new Date();
  let warning = out.refs?.pickupError
    ? `Booked, but the pickup isn't registered with Blue Dart: ${out.refs.pickupError}. Open the order and click Register pickup.`
    : "";
  if (order.channel === "amazon") {
    // Amazon order: tell Amazon the courier and AWB, and invoice it if OrdexaGo invoices Amazon orders.
    await order.save();
    warning = [warning, await require("../amazon/ship").afterBooked(order)]
      .filter(Boolean)
      .join(" · ");
  } else if (order.channel === "flipkart") {
    // Flipkart self-ship: tell Flipkart the courier and AWB.
    order.flipkart = { ...(order.flipkart || {}), selfShip: true };
    order.markModified("flipkart");
    await order.save();
    warning = [
      warning,
      await require("../flipkart/orders").afterSelfShipBooked(order),
    ]
      .filter(Boolean)
      .join(" · ");
  } else if (store?.fulfillInShopify) {
    try {
      order.shipment.shopifyFulfilled = await fulfillInShopify(
        store,
        order,
        order.shipment,
      );
    } catch (e) {
      warning = [
        warning,
        `Booked, but couldn't mark it fulfilled in Shopify: ${e.message}`,
      ]
        .filter(Boolean)
        .join(" · ");
      order.shipment.error = warning;
    }
  }
  await saveBooking(order, [
    "shipment",
    "status",
    "statusChangedAt",
    "flipkart",
  ]);
  return {
    awb: out.awb,
    courierName: out.courierName,
    charge: charge ?? null,
    warning,
  };
}

async function trackOrder(order) {
  const sh = order.shipment;
  if (sh?.carrier === "amazon_easyship")
    return require("../amazon/ship").trackEasyShip(order);
  if (!sh?.awb || !sh.account) return null;
  const acc = await CourierAccount.findById(sh.account);
  if (!acc) return null;
  const t = await CARRIERS[acc.carrier].track(acc, sh);
  if (t.status === "pending" && require("../couriers").handedOver(t.events))
    t.status = "in_transit";
  sh.trackStatus = t.status;
  sh.trackedAt = new Date();
  if (t.events?.length)
    sh.events = t.events.filter((e) => e.at && !isNaN(e.at)).slice(0, 50);
  // Several boxes: track each; the order is delivered when every box is, shipped once any has left.
  let overall = t.status;
  const extras = (order.extraShipments || []).filter(
    (x) => x?.awb && x.account,
  );
  if (extras.length && t.status !== "cancelled") {
    for (const x of extras) {
      try {
        const xa = await CourierAccount.findById(x.account);
        if (!xa) continue;
        const xt = await CARRIERS[xa.carrier].track(xa, x);
        if (
          xt.status === "pending" &&
          require("../couriers").handedOver(xt.events)
        )
          xt.status = "in_transit";
        x.trackStatus = xt.status;
        x.trackedAt = new Date();
        if (xt.events?.length)
          x.events = xt.events.filter((e) => e.at && !isNaN(e.at)).slice(0, 50);
      } catch {
        /* one box's tracking failing doesn't stop the others */
      }
    }
    order.markModified("extraShipments");
    const all = [
      t.status,
      ...extras.map((x) => x.trackStatus || "pending"),
    ].filter((x) => x !== "cancelled");
    overall = all.every((x) => x === "delivered")
      ? "delivered"
      : all.some((x) => x === "rto")
        ? "rto"
        : all.some((x) =>
              ["in_transit", "out_for_delivery", "delivered"].includes(x),
            )
          ? all.some((x) => x === "out_for_delivery")
            ? "out_for_delivery"
            : "in_transit"
          : "pending";
    if (overall === "delivered" || overall === "rto")
      overall = all.every((x) => ["delivered", "rto"].includes(x))
        ? overall
        : "in_transit";
  }
  const next = STATUS_FROM_TRACK[overall];
  if (
    t.status === "cancelled" &&
    ["ready_to_ship", "packed", "new"].includes(order.status)
  ) {
    // Courier cancelled the AWB: clear it (and the Shopify fulfilment) so the order can be booked again.
    order.markModified("shipment");
    await order.save();
    await cancelShipment(order, {
      courierDone: `cancelled by ${sh.courierName || "the courier"}${t.text ? ` (${t.text})` : ""}`,
    });
    return t;
  } else if (
    t.status !== "cancelled" &&
    ["packed", "new"].includes(order.status) &&
    sh.account
  ) {
    // Still booked (an earlier status said cancelled, e.g. only the pickup was): back to Ready to Ship.
    order.status = next || "ready_to_ship";
    order.statusChangedAt = new Date();
  } else if (
    next &&
    next !== order.status &&
    !["delivered", "rto", "cancelled"].includes(order.status)
  ) {
    order.status = next;
    order.statusChangedAt = new Date();
  } else if (next === "rto" && order.status === "delivered") {
    order.status = "rto";
  } else if (
    overall === "pending" &&
    order.status === "shipped" &&
    sh.account
  ) {
    // Marked shipped too early (booked, but the courier hasn't picked it up): back to Ready to Ship.
    order.status = "ready_to_ship";
    order.statusChangedAt = new Date();
  }
  order.markModified("shipment");
  await order.save();
  if (order.channel === "flipkart" && order.status === "delivered")
    await require("../flipkart/orders")
      .reportDelivered(order)
      .catch((e) =>
        console.error(`[flipkart] delivery of ${order.name}: ${e.message}`),
      );
  return t;
}

// Cancel the order's Shopify fulfilment that carries this AWB. Returns a note for the remarks ("" when nothing to do).
async function cancelInShopify(order, awb, sh = null) {
  // A box that made no Shopify fulfilment of its own: match by AWB only, never guess (it could be a seller's).
  const guess = !(sh && sh.shopifyFulfilled === false);
  try {
    const store = await ShopifyStore.findOne({
      organization: order.organization,
    });
    if (!store || !order.shopifyId?.startsWith("gid://shopify/Order/"))
      return "";
    const d = await gql(
      store,
      `query($id: ID!) { order(id: $id) { fulfillments(first: 20) { id status trackingInfo { number } } } }`,
      { id: order.shopifyId },
    );
    const live = (d.order?.fulfillments || []).filter(
      (f) =>
        f.status === "SUCCESS" || f.status === "OPEN" || f.status === "PENDING",
    );
    let mine = live.filter((f) =>
      (f.trackingInfo || []).some(
        (t) => String(t.number || "").trim() === String(awb).trim(),
      ),
    );
    // No fulfilment with this AWB: one made without a tracking number (or the order's only one) is this shipment's.
    if (!mine.length && guess) {
      const untracked = live.filter(
        (f) =>
          !(f.trackingInfo || []).some((t) => String(t.number || "").trim()),
      );
      mine = untracked.length ? untracked : live.length === 1 ? live : [];
    }
    if (!mine.length)
      return live.length
        ? "Shopify fulfilment has other tracking numbers — check it in Shopify"
        : "";
    for (const f of mine) {
      const r = await gql(
        store,
        `mutation($id: ID!) { fulfillmentCancel(id: $id) { fulfillment { id status } userErrors { field message } } }`,
        { id: f.id },
      );
      const errs = r.fulfillmentCancel?.userErrors || [];
      if (errs.length)
        return `Shopify fulfilment not cancelled (${errs.map((e) => e.message).join("; ")}) — mark it unfulfilled in Shopify`;
    }
    return "Shopify fulfilment cancelled";
  } catch (e) {
    return `Shopify fulfilment not cancelled (${e.message.slice(0, 120)}) — mark it unfulfilled in Shopify`;
  }
}

// force: the courier wouldn't cancel (already cancelled on its portal, manifested…) — cancel here and in Shopify anyway.
// courierDone: the courier has cancelled it already (seen in tracking) — only clear it here and in Shopify.
async function cancelShipment(order, { force = false, courierDone = "" } = {}) {
  const sh = order.shipment;
  if (!sh?.awb) throw new Error("No shipment to cancel");
  if (sh.carrier === "amazon_easyship")
    throw new Error(
      "Easy Ship pickups are cancelled or rescheduled in Seller Central",
    );
  if (["shipped", "delivered", "rto"].includes(order.status))
    throw new Error("The shipment has already left; raise it with the courier");
  const acc = sh.account ? await CourierAccount.findById(sh.account) : null;
  const was = `${sh.courierName || ""} ${sh.awb}`.trim();
  if (!courierDone && sh.trackStatus === "cancelled")
    courierDone = `already cancelled by ${sh.courierName || "the courier"}`;
  let courierNote = courierDone;
  if (acc && !courierDone) {
    try {
      await CARRIERS[acc.carrier].cancel(acc, sh);
    } catch (e) {
      if (!force) {
        const err = new Error(
          `${acc.name || sh.courierName} didn't cancel ${sh.awb}: ${e.message}`,
        );
        err.courierRefused = true;
        throw err;
      }
      courierNote = `not cancelled with ${sh.courierName || "the courier"} (${e.message.slice(0, 120)}) — cancel it there`;
    }
  }
  // The other boxes (several-box orders): cancelled with the courier too.
  const extras = (order.extraShipments || []).filter((x) => x?.awb);
  for (const x of extras) {
    if (x.trackStatus === "cancelled") continue;
    const xa = x.account ? await CourierAccount.findById(x.account) : null;
    if (!xa) continue;
    try {
      await CARRIERS[xa.carrier].cancel(xa, x);
    } catch (e) {
      if (!force) {
        const err = new Error(
          `${xa.name || x.courierName} didn't cancel box ${x.box} (${x.awb}): ${e.message}`,
        );
        err.courierRefused = true;
        throw err;
      }
      courierNote = [
        courierNote,
        `box ${x.box} ${x.awb} not cancelled with the courier — cancel it there`,
      ]
        .filter(Boolean)
        .join("; ");
    }
  }
  // Undo the Shopify fulfilment with this AWB too, so Shopify shows the order unfulfilled and it can be booked again.
  const shop = !(order.channel !== "shopify" && order.channel);
  let shopifyNote = shop ? await cancelInShopify(order, sh.awb, sh) : "";
  for (const x of extras)
    if (shop)
      shopifyNote = (await cancelInShopify(order, x.awb, x)) || shopifyNote;
  order.cancelledShipments = [
    ...(order.cancelledShipments || []),
    { courier: sh.courierName || "", awb: sh.awb, at: new Date() },
    ...extras.map((x) => ({
      courier: x.courierName || "",
      awb: x.awb,
      at: new Date(),
    })),
  ];
  const was2 = extras.length
    ? ` and ${extras.length} more box${extras.length === 1 ? "" : "es"} (${extras.map((x) => x.awb).join(", ")})`
    : "";
  order.shipment = {};
  order.extraShipments = undefined;
  order.boxes = undefined;
  order.awbScannedAt = undefined; // the scan belonged to the cancelled AWB (it stays in awbScans)
  order.awbScannedBy = undefined;
  order.remarks = `${order.remarks ? `${order.remarks}\n` : ""}Shipment ${was}${was2} cancelled on ${new Date().toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" })}${courierNote ? ` · ${courierNote}` : ""}${shopifyNote ? ` · ${shopifyNote}` : ""}`;
  order.status = "packed";
  order.statusChangedAt = new Date();
  await order.save();
  return { shopify: shopifyNote, courier: courierNote };
}

// Every couple of hours: shipments that are on the way, booked in the last 45 days.
async function trackAll() {
  const since = new Date(Date.now() - 45 * 86400000);
  const orders = await ShopifyOrder.find({
    status: { $in: ["ready_to_ship", "shipped"] },
    "shipment.awb": { $ne: "" },
    "shipment.account": { $exists: true },
    "shipment.bookedAt": { $gte: since },
  }).limit(2000);
  for (const o of orders) await trackOrder(o).catch(() => {});
  await require("./reverse")
    .trackAllReverse()
    .catch(() => {});
}

module.exports = {
  takesPayment,
  isCodOrder,
  accountForPayment,
  unfulfilledMap,
  storedUnfulfilled,
  remaining,
  shippableView,
  boxViews,
  allShipments,
  splitBoxes,
  boxOrder,
  bookOrder,
  trackOrder,
  cancelShipment,
  trackAll,
  fulfillInShopify,
};
