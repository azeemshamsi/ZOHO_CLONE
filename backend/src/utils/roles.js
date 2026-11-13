/**
 * Roles and what each can do, per module. "full" = view + create/edit/delete, "view" = read only, "none" = hidden.
 * Built-in roles below; admins can also make custom roles (models/Role.js), stored on a membership as "custom:<id>".
 */
const MODULES = [
  ["sales", "Sales", "Customers, quotes, sales orders, invoices, payments, credit notes"],
  ["purchases", "Purchases", "Vendors, bills, expenses, purchase orders, payments made"],
  ["items", "Items", "Items, adjustments, transfer orders, warehouses"],
  ["inventory", "Inventory", "Stock, racks, put-away, Shopify links"],
  ["banking", "Banking", "Bank accounts, statements, reconciliation"],
  ["accountant", "Accountant", "Chart of accounts, journals, budgets, fixed assets"],
  ["reports", "Reports", "All reports and the dashboard"],
  ["gst", "GST & Compliance", "GST returns, reconciliation, e-invoices, e-way bills"],
  ["store_orders", "Store: Orders", "Shopify orders, statuses, invoices from orders"],
  ["store_shipping", "Store: Shipping", "Book couriers, labels, tracking"],
  ["store_returns", "Store: Returns", "Mark returns and scan returned parcels"],
  ["store_settings", "Store: Settings", "Shopify connection, couriers, GST rules"],
  ["store_sellers", "Store: Sellers", "Marketplace sellers, their logins and pickups, deductions, monthly purchase orders"],
  ["inbox", "Inbox", "Read and reply to WhatsApp, Instagram, Messenger, comments and email; see the customer's orders"],
  ["marketing", "Marketing", "Integrations, WhatsApp order updates, campaigns, auto-replies, opt-outs"],
  ["settings", "Settings & Users", "Company settings, users, roles, currencies, branches"],
];
// Pages inside a module that a custom role can set on their own ("purchases.purchase_orders"). A page with no
// setting of its own follows its module.
const FEATURES = {
  sales: [["customers", "Customers"], ["quotes", "Quotes"], ["sales_orders", "Sales Orders"], ["invoices", "Invoices"], ["recurring", "Recurring Invoices"], ["payments", "Payments Received"], ["credit_notes", "Credit Notes"], ["ledgers", "Sales Ledgers"], ["amazon", "Amazon Sales"], ["flipkart", "Flipkart Sales"], ["pepperfry", "Pepperfry Sales"], ["projects", "Time Tracking (projects, timesheet)"]],
  purchases: [["vendors", "Vendors"], ["expenses", "Expenses"], ["purchase_orders", "Purchase Orders"], ["bills", "Bills"], ["recurring", "Recurring Bills & Expenses"], ["payments_made", "Payments Made"], ["vendor_credits", "Vendor Credits"], ["ledgers", "Purchase Ledgers"]],
  items: [["items", "Items"], ["adjustments", "Inventory Adjustments"], ["transfer_orders", "Transfer Orders"]],
  store_orders: [["new_order", "Create new orders (in Shopify)"], ["abandoned", "Abandoned Checkouts"]],
  accountant: [["journals", "Manual Journals"], ["accounts", "Chart of Accounts"], ["fixed_assets", "Fixed Assets"], ["budgets", "Budgets"]],
};
const KEYS = MODULES.map((m) => m[0]);
const FEATURE_KEYS = Object.entries(FEATURES).flatMap(([m, list]) => list.map(([f]) => `${m}.${f}`));
const ALL_KEYS = [...KEYS, ...FEATURE_KEYS];
const all = (level) => Object.fromEntries(KEYS.map((k) => [k, level]));
// Every page of a module plus the module itself: used for lookups any page of the module needs (vendor list…).
const anyOf = (mod) => [mod, ...(FEATURES[mod] || []).map(([f]) => `${mod}.${f}`)];
// Fill in each page's level from its module where the role doesn't set one.
function expand(perms = {}) {
  const out = { ...all("none"), ...perms };
  for (const [m, list] of Object.entries(FEATURES)) for (const [f] of list) out[`${m}.${f}`] = perms[`${m}.${f}`] || out[m] || "none";
  return out;
}

const ROLES = {
  admin: { label: "Admin", desc: "Full access, including settings and users.", perms: all("full") },
  accountant: { label: "Accountant", desc: "Everything except company settings and users.", perms: { ...all("full"), settings: "none", store_settings: "view", store_sellers: "view", inbox: "none", marketing: "none" } },
  staff: { label: "Staff", desc: "Sales, purchases, items, inventory, GST documents, the store and the Inbox. Can view reports.", perms: { ...all("full"), banking: "none", accountant: "none", reports: "view", settings: "none", store_settings: "none", store_sellers: "none", marketing: "none" } },
  sales: { label: "Sales Staff", desc: "Customers, quotes, sales orders, invoices, payments, store orders and the Inbox.", perms: { ...all("none"), sales: "full", items: "view", store_orders: "full", inbox: "full" } },
  order_taker: { label: "Order Taker", desc: "Creates new orders in Shopify and follows up abandoned checkouts; sees store orders but can't change, ship or cancel them.", perms: { ...all("none"), store_orders: "view", "store_orders.new_order": "full", "store_orders.abandoned": "full", items: "view" }, home: "/shopify-orders" },
  support: { label: "Support", desc: "Only the Inbox: reads and replies to customers' messages and sees their orders there.", perms: { ...all("none"), inbox: "full" }, home: "/inbox" },
  marketer: { label: "Marketing", desc: "Inbox and Marketing: campaigns, WhatsApp order updates, auto-replies and integrations.", perms: { ...all("none"), inbox: "full", marketing: "full" }, home: "/inbox" },
  warehouse: { label: "Warehouse", desc: "Store orders, shipping, returns and inventory. No accounts.", perms: { ...all("none"), items: "view", inventory: "full", store_orders: "full", store_shipping: "full", store_returns: "full" } },
  seller_manager: { label: "Seller Manager", desc: "Adds and manages marketplace sellers: their logins, pickup addresses, deductions and monthly purchase orders. Sees store orders.", perms: { ...all("none"), store_sellers: "full", store_orders: "view", items: "view" }, home: "/sellers" },
  returns: { label: "Returns Desk", desc: "Only scans and closes returned parcels.", perms: { ...all("none"), store_returns: "full" }, home: "/returns-scan" },
  seller: { label: "Seller", desc: "A marketplace seller: only their own orders, labels, stock and purchase orders (Store → Sellers).", perms: all("none"), home: "/seller", hidden: true },
  viewer: { label: "View Only", desc: "Can see everything except settings, can't change anything.", perms: { ...all("view"), settings: "none", store_settings: "none", marketing: "none" } },
};

const permsOf = (role) => expand((ROLES[role] || ROLES.viewer).perms);
const CORE = ["sales", "purchases", "items", "inventory", "banking", "accountant", "reports", "gst"];

// Permissions for a user's roles in an organization: the main role plus any extra roles, combined (the highest
// level per module wins). The label joins the names; the home page is the main role's.
async function resolveRole(role, org, extra = []) {
  const main = await resolveOne(role, org);
  const more = [...new Set((extra || []).filter((x) => x && x !== role))];
  if (!more.length) return main;
  const rank = { none: 0, view: 1, full: 2 };
  const perms = { ...main.perms };
  const labels = [main.label];
  for (const k of more) {
    const r = await resolveOne(k, org);
    labels.push(r.label);
    for (const key of ALL_KEYS) if (rank[r.perms[key] || "none"] > rank[perms[key] || "none"]) perms[key] = r.perms[key];
  }
  return { label: labels.join(" + "), perms, home: main.home };
}

async function resolveOne(role, org) {
  if (String(role || "").startsWith("custom:")) {
    const Role = require("../models/Role");
    const r = await Role.findOne({ _id: role.slice(7), organization: org }).lean().catch(() => null);
    if (r) return { label: r.name, perms: expand(r.perms), home: r.home || "" };
    return { label: "Viewer", perms: expand(ROLES.viewer.perms), home: "" };
  }
  const b = ROLES[role] || ROLES.viewer;
  return { label: b.label, perms: expand(b.perms), home: b.home || "" };
}

// Express middleware: GET needs "view", anything else needs "full". `module` may be a function of req.
// readAll: lookups (items, accounts…) any user with access to a core module may read.
const permit = (module, { readAll = false } = {}) =>
  function (req, res, next) {
    const m = typeof module === "function" ? module(req) : module;
    const perms = req.perms || permsOf(req.user.role);
    const rank = { none: 0, view: 1, full: 2 };
    const level = m === null ? "view" : (Array.isArray(m) ? m : [m]).map((x) => perms[x] || "none").sort((a, b) => rank[b] - rank[a])[0];
    const reading = req.method === "GET" || req.method === "HEAD";
    const anyCore = CORE.flatMap(anyOf).some((k) => (perms[k] || "none") !== "none") || ["store_orders", "store_shipping"].some((k) => (perms[k] || "none") !== "none");
    if (reading && ((readAll && anyCore) || level !== "none")) return next();
    if (!reading && level === "full") return next();
    res.status(403).send({ message: reading ? "You don't have access to this" : "Your role doesn't allow changes here. Ask an admin." });
  };

module.exports = { MODULES, FEATURES, KEYS, FEATURE_KEYS, ALL_KEYS, ROLES, CORE, anyOf, expand, permsOf, resolveRole, permit };
