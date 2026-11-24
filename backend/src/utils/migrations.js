/**
 * One-time data changes, run at start-up. Each runs once per database (recorded in `migrations`).
 */
const mongoose = require("mongoose");

const MIGRATIONS = [
  {
    // Shopify stock sync per item used to start on; it now starts off until the user turns it on.
    id: "2026-11-item-shopify-sync-off",
    run: async () => {
      const Item = require("../models/Item");
      await Item.updateMany(
        { shopifySync: { $ne: false }, shopifySyncByUser: { $ne: true } },
        { $set: { shopifySync: false } },
      );
    },
  },
  {
    // Shopify orders paid "manual" / pending or tagged COD (e.g. "CASHFREE - COD") were taken as prepaid.
    id: "2026-11-shopify-cod-from-tags-and-pending",
    run: async () => {
      const ShopifyOrder = require("../models/ShopifyOrder");
      const rx = /\bcod\b|cash on delivery|cash_on_delivery|cash-on-delivery/i;
      const list = await ShopifyOrder.find(
        {
          paymentMode: "prepaid",
          $or: [{ tags: { $regex: rx } }, { financialStatus: "PENDING" }],
        },
        { total: 1, outstanding: 1, prepaidAmount: 1 },
      ).lean();
      for (const o of list) {
        if ((o.prepaidAmount || 0) >= 0.5) continue;
        await ShopifyOrder.updateOne(
          { _id: o._id },
          {
            paymentMode: "cod",
            codAmount: o.outstanding || o.total || 0,
            prepaidAmount: 0,
          },
        );
      }
      console.log(`COD fix: ${list.length} order(s) checked`);
    },
  },
  {
    // Items matched to a Shopify listing (e.g. Tally items) never got the listing's SKU.
    id: "2026-11-item-sku-from-shopify",
    run: async () => {
      const Item = require("../models/Item");
      const ShopifyOrder = require("../models/ShopifyOrder");
      const skus = await ShopifyOrder.aggregate([
        { $unwind: "$lines" },
        {
          $match: {
            "lines.variantId": { $nin: ["", null] },
            "lines.sku": { $nin: ["", null] },
          },
        },
        { $group: { _id: "$lines.variantId", sku: { $first: "$lines.sku" } } },
      ]);
      const by = new Map(skus.map((s) => [s._id, s.sku]));
      const items = await Item.find(
        {
          shopifyVariantId: { $nin: ["", null] },
          $or: [{ sku: "" }, { sku: null }, { sku: { $exists: false } }],
        },
        { shopifyVariantId: 1 },
      ).lean();
      let n = 0;
      for (const it of items) {
        const sku = by.get(it.shopifyVariantId);
        if (sku) {
          await Item.updateOne({ _id: it._id }, { sku });
          n++;
        }
      }
      console.log(`SKU backfill: ${n} item(s)`);
    },
  },
  {
    // Products with the same name but different SKUs had been merged into one item: separate them.
    id: "2026-11-split-items-by-sku",
    run: async () => {
      const { splitMergedItems } = require("./shopify/splitSkus");
      const r = await splitMergedItems();
      const db = mongoose.connection.db;
      await db
        .collection("migration_reports")
        .updateOne(
          { _id: "split-items-by-sku" },
          { $set: { at: new Date(), ...r } },
          { upsert: true },
        );
    },
  },
  {
    // Orders still "shipped" although their Shopify fulfilment was cancelled.
    id: "2026-11-cancelled-shopify-fulfilments",
    run: async () => {
      const ShopifyOrder = require("../models/ShopifyOrder");
      const { undoCancelledFulfilment } = require("./shopify/sync");
      const list = await ShopifyOrder.find({
        status: { $in: ["shipped", "ready_to_ship"] },
        fulfillmentStatus: {
          $in: [
            "UNFULFILLED",
            "OPEN",
            "PENDING_FULFILLMENT",
            "ON_HOLD",
            "SCHEDULED",
          ],
        },
      });
      let n = 0;
      // Fulfilments were stored without their status, so a stored one on an unfulfilled order was cancelled.
      for (const o of list)
        if (
          undoCancelledFulfilment(o, (o.shopifyFulfillments || []).length > 0)
        )
          (await o.save(), n++);
      console.log(`Cancelled Shopify fulfilments: ${n} order(s) put back`);
    },
  },
  {
    // Tally sales / purchase ledgers imported before they were marked as such: mark them from their use.
    id: "2026-11-ledger-kinds-from-use",
    run: async () => {
      const r = await require("./import/ledgerKinds").markLedgerKinds();
      console.log(
        `Ledger kinds: ${r.sales} sales and ${r.purchase} purchase ledger(s) marked`,
      );
    },
  },
  {
    // Again, without the "blank or missing" query the Oracle MongoDB API didn't match.
    id: "2026-11-ledger-kinds-from-use-2",
    run: async () => {
      const r = await require("./import/ledgerKinds").markLedgerKinds();
      console.log(
        `Ledger kinds: ${r.sales} sales and ${r.purchase} purchase ledger(s) marked (${r.accounts} accounts, ${r.usedBySales} used by invoices)`,
      );
      await mongoose.connection.db
        .collection("migration_reports")
        .updateOne(
          { _id: "ledger-kinds" },
          { $set: { at: new Date(), ...r } },
          { upsert: true },
        );
    },
  },
  {
    // Azeem's master sales ledger "Invoice Sale": the Tally sales ledgers named "Invoice Sale …".
    id: "2026-11-master-ledger-invoice-sale",
    run: async () => {
      const Account = require("../models/Account");
      const LedgerGroup = require("../models/LedgerGroup");
      const accounts = await Account.find(
        { ledgerKind: "sales" },
        { name: 1, organization: 1 },
      ).lean();
      const byOrg = new Map();
      for (const a of accounts)
        if (/^invoice\s+sale/i.test(a.name || ""))
          byOrg.set(String(a.organization), [
            ...(byOrg.get(String(a.organization)) || []),
            String(a._id),
          ]);
      for (const [org, members] of byOrg) {
        if (
          members.length < 2 ||
          (await LedgerGroup.exists({
            organization: org,
            kind: "sales",
            name: "Invoice Sale",
          }))
        )
          continue;
        await LedgerGroup.create({
          organization: org,
          kind: "sales",
          name: "Invoice Sale",
          members,
        });
        console.log(
          `Master ledger "Invoice Sale": ${members.length} ledgers (org ${org})`,
        );
      }
    },
  },
  {
    // Subscriptions: everything that exists today is the owner's own account ("OrdexaGo (owner)": no expiry,
    // no limits). The superadmin is the email(s) in SUPERADMIN_EMAILS, else the first user ever created.
    id: "2026-11-subscribers-owner",
    run: async () => {
      const Subscriber = require("../models/Subscriber");
      const Organization = require("../models/Organization");
      const User = require("../models/User");
      let owner = await Subscriber.findOne({ owner: true });
      if (!owner)
        owner = await Subscriber.create({
          name: "OrdexaGo (owner)",
          owner: true,
          status: "active",
        });
      const orgs = await Organization.find({}, { subscriber: 1 }).lean();
      let n = 0;
      for (const o of orgs.filter((x) => !x.subscriber)) {
        await Organization.updateOne(
          { _id: o._id },
          { $set: { subscriber: owner._id } },
        );
        n++;
      }
      const emails = String(
        process.env.SUPERADMIN_EMAILS || "azeem@zikrziba.com",
      )
        .toLowerCase()
        .split(/[,\s]+/)
        .filter(Boolean);
      const users = await User.find(
        {},
        { email: 1, createdAt: 1, superadmin: 1 },
      ).lean();
      let supers = users.filter((u) => emails.includes(u.email));
      if (!supers.length)
        supers = users
          .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
          .slice(0, 1);
      for (const u of supers)
        await User.updateOne({ _id: u._id }, { $set: { superadmin: true } });
      const r = { companies: n, superadmins: supers.map((u) => u.email) };
      await mongoose.connection.db
        .collection("migration_reports")
        .updateOne(
          { _id: "subscribers-owner" },
          { $set: { at: new Date(), ...r } },
          { upsert: true },
        );
      console.log(
        `Subscribers: ${n} companies on the owner account; superadmin ${r.superadmins.join(", ")}`,
      );
    },
  },
  {
    // Seller deductions have no ledger of their own (they lower the purchase on the bill): remove the
    // "Penalties from Sellers" account if it was created and never used; otherwise rename it.
    id: "2026-11-seller-deductions-no-ledger",
    run: async () => {
      const Account = require("../models/Account");
      const db = mongoose.connection.db;
      for (const a of await Account.find({ role: "seller_penalties" })) {
        const code = String(a._id);
        const used =
          (await db
            .collection("bills")
            .countDocuments({ adjustmentAccount: code })) +
          (await db
            .collection("purchaseorders")
            .countDocuments({ adjustmentAccount: code }));
        if (!used) await a.deleteOne();
        else {
          await db
            .collection("purchaseorders")
            .updateMany(
              { adjustmentAccount: code, status: { $ne: "billed" } },
              { $set: { adjustmentAccount: "ledger" } },
            );
          await Account.updateOne(
            { _id: a._id },
            { $set: { name: "Seller Deductions", role: "" } },
          );
        }
      }
    },
  },
  {
    // Sellers made before "Purchase orders from" existed: start from 1 Oct 2026 (not every delivery ever).
    id: "2026-11-seller-po-from",
    run: async () => {
      const Seller = require("../models/Seller");
      for (const s of await Seller.find({}, { poFrom: 1 }).lean())
        if (!s.poFrom)
          await Seller.updateOne(
            { _id: s._id },
            { $set: { poFrom: new Date("2026-09-30T18:30:00Z") } },
          );
    },
  },
  {
    // Password expiry (365 days) counts from today for existing users — nobody is forced to change at once.
    id: "2026-11-password-changed-at",
    run: async () => {
      const User = require("../models/User");
      const now = new Date();
      let n = 0;
      for (const u of await User.find({}, { passwordChangedAt: 1 }).lean()) {
        if (u.passwordChangedAt) continue;
        await User.collection.updateOne(
          { _id: u._id },
          { $set: { passwordChangedAt: now } },
        );
        n++;
      }
      console.log(`Password policy: ${n} user(s) start their 365 days today`);
    },
  },
  {
    // #200962 was booked in 14 Blue Dart boxes on 21 Nov 2026 and fulfilled in Shopify, but the 15-minute sync saved
    // the order at the same moment, so OrdexaGo couldn't save the AWBs. Put them back (from Shopify's fulfilments).
    // Box 12 (AFR10077 part 2 of 2) made no Shopify fulfilment; its AWB is the one Blue Dart issued between box 11
    // and box 13 — check it in Blue Dart.
    // v2: the sync had meanwhile taken the last box's AWB from Shopify as the order's only shipment, so v1 skipped it.
    id: "2026-11-restore-200962-boxes-v2",
    run: async () => {
      const ShopifyOrder = require("../models/ShopifyOrder");
      const CourierAccount = require("../models/CourierAccount");
      const { codOf } = require("./couriers");
      const o = await ShopifyOrder.findOne({ name: "#200962" }).lean();
      if (
        !o ||
        (o.extraShipments || []).length ||
        (o.shipment?.awb && !/^68510700[78]/.test(o.shipment.awb))
      )
        return console.log("#200962: nothing to restore");
      const acc = await CourierAccount.findOne({
        organization: o.organization,
        carrier: "bluedart",
        active: true,
      }).lean();
      const plan = [
        ["AFR8141", "68510700694"],
        ["AFR8141", "68510700705"],
        ["AFR8141", "68510700716"],
        ["AFR8141", "68510700720"],
        ["AFR8141", "68510700731"],
        ["AFR8140", "68510700742"],
        ["AFR8140", "68510700753"],
        ["AFR8140", "68510700764"],
        ["AFR8140", "68510700775"],
        ["AFR8140", "68510700786"],
        ["AFR10077", "68510700790", 1, 2],
        ["AFR10077", "68510700801", 2, 2],
        ["AFR7065", "68510700812", 0, 0, 5],
        ["AFR4408", "68510700823"],
      ];
      const line = (sku) =>
        (o.lines || []).find((l) => String(l.sku || "").toUpperCase() === sku);
      if (plan.some(([sku]) => !line(sku)))
        return console.log("#200962: products don't match — not restored");
      const unit = (l) => (l.quantity ? l.total / l.quantity : 0);
      const boxes = plan.map(([sku, awb, part, of, qty]) => {
        const l = line(sku);
        const q = qty || 1;
        return { awb, l, q, part, of, value: (unit(l) * q) / (of || 1) };
      });
      // COD: the order's COD for our products (the seller shipped wave-10 themselves), shared by value.
      const full = (o.lines || [])
        .filter((l) => l.quantity > 0)
        .reduce((t, l) => t + (l.total || 0), 0);
      const ours = boxes.reduce((t, b) => t + b.value, 0);
      const codTotal =
        full > 0 ? Math.round(((codOf(o) * ours) / full) * 100) / 100 : 0;
      let left = codTotal;
      const n = boxes.length;
      const now = new Date("2026-11-21T09:48:20Z");
      const ships = boxes.map((b, i) => {
        const c =
          i === n - 1
            ? Math.round(left * 100) / 100
            : Math.round(((codTotal * b.value) / ours) * 100) / 100;
        left -= c;
        const title =
          (b.l.variantTitle
            ? `${b.l.title} - ${b.l.variantTitle}`
            : b.l.title) + (b.of ? ` (part ${b.part} of ${b.of})` : "");
        return {
          ...(acc ? { account: acc._id } : {}),
          carrier: "bluedart",
          courierName: "Blue Dart",
          awb: b.awb,
          labelUrl: "",
          trackingUrl: acc?.trackingUrl
            ? acc.trackingUrl.replace("{awb}", b.awb)
            : "",
          refs: {},
          codAmount: c,
          bookedAt: now,
          trackStatus: "pending",
          events: [],
          box: i + 1,
          of: n,
          shopifyFulfilled: !(b.part > 1),
          lines: [
            {
              lineId: String(b.l.lineId),
              title,
              sku: b.l.sku || "",
              quantity: b.q,
              ...(b.of ? { part: b.part, of: b.of } : {}),
            },
          ],
        };
      });
      await ShopifyOrder.updateOne(
        { _id: o._id },
        {
          $set: {
            shipment: ships[0],
            extraShipments: ships.slice(1),
            boxes: ships.map((x) => ({
              box: x.box,
              lines: x.lines,
              booked: true,
            })),
            status: "ready_to_ship",
            statusChangedAt: now,
            remarks: `${o.remarks ? `${o.remarks}\n` : ""}14 Blue Dart boxes restored from Shopify after a save clash on 21 Nov 2026 — box 12 AWB 68510700801 (AFR10077 part 2) to be checked in Blue Dart`,
          },
        },
      );
      console.log(`#200962: ${n} boxes restored, COD ₹${codTotal}`);
    },
  },
  {
    // #200962's restored boxes had no weight / size (lost with the failed save): the ones entered at booking.
    id: "2026-11-200962-box-sizes",
    run: async () => {
      const ShopifyOrder = require("../models/ShopifyOrder");
      const o = await ShopifyOrder.findOne({ name: "#200962" }).lean();
      if (!o || (o.extraShipments || []).length !== 13)
        return console.log("#200962: sizes not set");
      const pouf = [7, 50, 43, 42];
      const size = {
        11: [10.8, 112, 46, 24],
        12: [12, 66, 37, 37],
        13: [16.1, 47, 47, 44],
        14: [4, 37, 37, 36],
      };
      const fill = (x) => {
        const [weight, length, breadth, height] = size[x.box] || pouf;
        return x.weight ? x : { ...x, weight, length, breadth, height };
      };
      await ShopifyOrder.updateOne(
        { _id: o._id },
        {
          $set: {
            shipment: fill(o.shipment),
            extraShipments: o.extraShipments.map(fill),
          },
          $inc: { __v: 1 },
        },
      );
      console.log("#200962: box sizes set");
    },
  },
  {
    // Tally manufacturing journals carry labour as an additional cost that Tally adds to what's produced; the first
    // import left it out, so made items were valued too low. Their rates (from the Day Book of 21 Nov 2026).
    id: "2026-11-tally-mfg-additional-costs",
    run: async () => {
      const InventoryAdjustment = require("../models/InventoryAdjustment");
      const fix = require("./data/tallyMfgRates.json");
      let n = 0;
      for (const f of fix) {
        const key = `tally:stockAdjustment:${f.n.toLowerCase()}|${f.d}`;
        for (const a of await InventoryAdjustment.find({ importRef: key })) {
          const made = a.lines.filter((l) => l.quantityAdjusted > 0);
          if (made.length !== f.r.length) continue;
          made.forEach((l, i) => (l.costPrice = f.r[i]));
          a.markModified("lines");
          await a.save();
          n++;
        }
      }
      console.log(
        `Tally manufacturing: ${n} journals now include their additional costs`,
      );
    },
  },
  {
    // The manufacturing view (like Tally): components' rates, each made item's % of cost and the labour /
    // additional costs, for the manufacturing journals already imported from Tally.
    id: "2026-11-tally-mfg-details",
    run: async () => {
      const InventoryAdjustment = require("../models/InventoryAdjustment");
      const { chartOfAccounts } = require("./ledger");
      const data = require("./data/tallyMfg.json").filter((f) =>
        /^manufacturing/i.test(f.n),
      );
      const charts = new Map();
      let n = 0;
      for (const f of data) {
        const key = `tally:stockAdjustment:${f.n.toLowerCase()}|${f.d}`;
        for (const a of await InventoryAdjustment.find({ importRef: key })) {
          if (a.lines.length !== f.l.length) continue;
          const org = String(a.organization);
          if (!charts.has(org))
            charts.set(org, await chartOfAccounts(a.organization));
          const chart = charts.get(org);
          a.lines.forEach((l, i) => {
            if (f.l[i][0]) l.rate = f.l[i][0];
            if (f.l[i][1] != null) l.costPercent = f.l[i][1];
          });
          a.additionalCosts = f.c.map(([name, percent, amount]) => ({
            account:
              chart.find(
                (c) =>
                  c.name.trim().toLowerCase() === name.trim().toLowerCase(),
              )?.code || "",
            name,
            percent,
            amount,
          }));
          a.reason = "Manufacturing";
          a.markModified("lines");
          await a.save();
          n++;
        }
      }
      console.log(
        `Tally manufacturing: ${n} journals have their components, % of cost and additional costs`,
      );
    },
  },
  {
    // Shiraz Handicrafts: opening stock as per Tally's books is ₹38,57,264 (its items add up to ₹30,52,239.94).
    id: "2026-11-shiraz-opening-stock",
    run: async () => {
      const Organization = require("../models/Organization");
      const Journal = require("../models/Journal");
      for (const o of await Organization.find(
        { name: /shiraz handicrafts/i },
        { _id: 1, name: 1, tallyOpeningStock: 1 },
      ).lean()) {
        if (o.tallyOpeningStock) continue;
        const fromTally = (
          await Journal.find({ organization: o._id }, { importRef: 1 })
            .limit(20000)
            .lean()
        ).some((j) => /^tally:/.test(j.importRef || ""));
        if (!fromTally) continue;
        const r = await require("./openingStock").setOpeningStock(
          o._id,
          3857264,
        );
        console.log(
          `${o.name}: opening stock as per books ₹${r.target} (items ₹${r.itemsTotal}, difference ₹${r.diff})`,
        );
      }
    },
  },
  {
    // Shiraz Handicrafts asked: its two "B2B @ 5%" sales ledgers (Tally's, and the one the marketplace import made —
    // renamed) become one ledger "B2B Sale @ 5%", in the Online Sale group; Tally's name stays as an alias.
    id: "2026-11-shiraz-merge-b2b-5",
    run: async () => {
      const Organization = require("../models/Organization");
      const Account = require("../models/Account");
      const LedgerGroup = require("../models/LedgerGroup");
      const { moveEntries } = require("./mergeLedger");
      const norm = (x) => String(x || "").toLowerCase().replace(/[^a-z0-9%@.]/g, "");
      for (const o of (await Organization.find({}, { _id: 1, name: 1 }).lean()).filter((x) => /shiraz handicrafts/i.test(x.name || ""))) {
        const twins = (await Account.find({ organization: o._id }).lean()).filter(
          (a) => a.active !== false && ["b2b@5%", "outstateb2b@5%"].includes(norm(a.name)),
        );
        if (twins.length !== 2) {
          console.log(`${o.name}: B2B @ 5% merge skipped (${twins.length} ledgers found)`);
          continue;
        }
        const grouped = new Set((await LedgerGroup.find({ organization: o._id }).lean()).flatMap((g) => g.members || []));
        // Keep Tally's own ledger (not in a group, or the older one); the other's entries move to it.
        const [keep, gone] = [...twins].sort(
          (a, b) => grouped.has(String(a._id)) - grouped.has(String(b._id)) || new Date(a.createdAt) - new Date(b.createdAt),
        );
        const moved = await moveEntries(o._id, String(gone._id), String(keep._id), "B2B Sale @ 5%");
        await Account.updateOne(
          { _id: gone._id },
          { $set: { active: false, description: `${gone.description ? `${gone.description} · ` : ""}Merged into B2B Sale @ 5%` } },
        );
        await Account.updateOne(
          { _id: keep._id },
          { $set: { name: "B2B Sale @ 5%", ledgerKind: "sales", aliases: [...new Set([...(keep.aliases || []), "B2B @ 5%", "Outstate B2B @ 5%"])] } },
        );
        console.log(`${o.name}: B2B @ 5% ledgers merged into "B2B Sale @ 5%" — moved ${JSON.stringify(moved)}`);
      }
    },
  },
  {
    // Shiraz Handicrafts asked: its Online Sale ledgers (as in Tally) all under the Online Sale head.
    id: "2026-11-shiraz-online-sale-members",
    run: async () => {
      const Organization = require("../models/Organization");
      const Account = require("../models/Account");
      const LedgerGroup = require("../models/LedgerGroup");
      const norm = (x) => String(x || "").toLowerCase().replace(/[^a-z0-9%@]/g, "");
      const WANT = ["Local B2B @ 5%", "Local Sales @ 18%", "Local Sales 5%", "Outstate B2B @ 18%", "OutState Sales 18%", "OutState Sales 5%", "B2B Sale @ 5%"].map(norm);
      for (const o of (await Organization.find({}, { _id: 1, name: 1 }).lean()).filter((x) => /shiraz handicrafts/i.test(x.name || ""))) {
        const groups = await LedgerGroup.find({ organization: o._id, kind: "sales" });
        const online = groups.find((g) => norm(g.name) === "onlinesale");
        if (!online) {
          console.log(`${o.name}: no Online Sale head — skipped`);
          continue;
        }
        const ids = (await Account.find({ organization: o._id }).lean())
          .filter((a) => a.active !== false && WANT.includes(norm(a.name)))
          .map((a) => String(a._id));
        // A ledger sits in one head: out of any other sales head, into Online Sale.
        for (const g of groups)
          if (String(g._id) !== String(online._id) && (g.members || []).some((m) => ids.includes(m))) {
            g.members = g.members.filter((m) => !ids.includes(m));
            await g.save();
          }
        online.members = [...new Set([...(online.members || []), ...ids])];
        await online.save();
        console.log(`${o.name}: ${ids.length} ledgers under Online Sale`);
      }
    },
  },
];

async function runMigrations() {
  const done = mongoose.connection.db.collection("migrations");
  for (const m of MIGRATIONS) {
    try {
      if (await done.findOne({ _id: m.id })) continue;
      await m.run();
      await done.insertOne({ _id: m.id, at: new Date() });
      console.log(`Migration ${m.id} done`);
    } catch (e) {
      console.error(`Migration ${m.id} failed: ${e.message}`);
    }
  }
}

module.exports = { runMigrations };
