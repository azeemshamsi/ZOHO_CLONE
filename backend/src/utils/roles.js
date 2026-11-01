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
  ["settings", "Settings & Users", "Company settings, users, roles, currencies, branches"],
];
const KEYS = MODULES.map((m) => m[0]);
const all = (level) => Object.fromEntries(KEYS.map((k) => [k, level]));

const ROLES = {
  admin: { label: "Admin", desc: "Full access, including settings and users.", perms: all("full") },
  accountant: { label: "Accountant", desc: "Everything except company settings and users.", perms: { ...all("full"), settings: "none", store_settings: "view" } },
  staff: { label: "Staff", desc: "Sales, purchases, items, inventory, GST documents and the store. Can view reports.", perms: { ...all("full"), banking: "none", accountant: "none", reports: "view", settings: "none", store_settings: "none" } },
  sales: { label: "Sales Staff", desc: "Customers, quotes, sales orders, invoices, payments and store orders.", perms: { ...all("none"), sales: "full", items: "view", store_orders: "full" } },
  warehouse: { label: "Warehouse", desc: "Store orders, shipping, returns and inventory. No accounts.", perms: { ...all("none"), items: "view", inventory: "full", store_orders: "full", store_shipping: "full", store_returns: "full" } },
  returns: { label: "Returns Desk", desc: "Only scans and closes returned parcels.", perms: { ...all("none"), store_returns: "full" }, home: "/returns-scan" },
  viewer: { label: "View Only", desc: "Can see everything except settings, can't change anything.", perms: { ...all("view"), settings: "none", store_settings: "none" } },
};

const permsOf = (role) => (ROLES[role] || ROLES.viewer).perms;
const CORE = ["sales", "purchases", "items", "inventory", "banking", "accountant", "reports", "gst"];

// Permissions for a role key in an organization (built-in or custom).
async function resolveRole(role, org) {
  if (String(role || "").startsWith("custom:")) {
    const Role = require("../models/Role");
    const r = await Role.findOne({ _id: role.slice(7), organization: org }).lean().catch(() => null);
    if (r) return { label: r.name, perms: { ...all("none"), ...r.perms }, home: r.home || "" };
    return { label: "Viewer", perms: ROLES.viewer.perms, home: "" };
  }
  const b = ROLES[role] || ROLES.viewer;
  return { label: b.label, perms: b.perms, home: b.home || "" };
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
    const anyCore = CORE.some((k) => (perms[k] || "none") !== "none") || ["store_orders", "store_shipping"].some((k) => (perms[k] || "none") !== "none");
    if (reading && ((readAll && anyCore) || level !== "none")) return next();
    if (!reading && level === "full") return next();
    res.status(403).send({ message: reading ? "You don't have access to this" : "Your role doesn't allow changes here. Ask an admin." });
  };

module.exports = { MODULES, KEYS, ROLES, CORE, permsOf, resolveRole, permit };
