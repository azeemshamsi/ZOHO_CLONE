/**
 * Roles and what each can do, per module. "full" = view + create/edit/delete, "view" = read only.
 */
const MODULES = ["sales", "purchases", "items", "banking", "accountant", "reports", "settings"];

const ROLES = {
  admin: { label: "Admin", desc: "Full access, including settings and users.", perms: Object.fromEntries(MODULES.map((m) => [m, "full"])) },
  accountant: {
    label: "Accountant",
    desc: "Everything except organization settings and users.",
    perms: { sales: "full", purchases: "full", items: "full", banking: "full", accountant: "full", reports: "full", settings: "none" },
  },
  staff: {
    label: "Staff",
    desc: "Sales, purchases and items. Can view reports. No banking or accountant.",
    perms: { sales: "full", purchases: "full", items: "full", banking: "none", accountant: "none", reports: "view", settings: "none" },
  },
  sales: {
    label: "Sales Staff",
    desc: "Customers, quotes, sales orders, invoices and payments only.",
    perms: { sales: "full", purchases: "none", items: "view", banking: "none", accountant: "none", reports: "none", settings: "none" },
  },
  viewer: { label: "View Only", desc: "Can see everything except settings, can't change anything.", perms: { ...Object.fromEntries(MODULES.map((m) => [m, "view"])), settings: "none" } },
};

const permsOf = (role) => (ROLES[role] || ROLES.viewer).perms;

// Express middleware: GET needs "view", anything else needs "full". `module` may be a function of req.
const permit = (module, { readAll = false } = {}) =>
  function (req, res, next) {
    const m = typeof module === "function" ? module(req) : module;
    const perms = permsOf(req.user.role);
    const rank = { none: 0, view: 1, full: 2 };
    // An array means "the best access across these modules".
    const level = m === null ? "view" : (Array.isArray(m) ? m : [m]).map((x) => perms[x] || "none").sort((a, b) => rank[b] - rank[a])[0];
    const reading = req.method === "GET" || req.method === "HEAD";
    if (reading && (readAll || level !== "none")) return next();
    if (!reading && level === "full") return next();
    res.status(403).send({ message: reading ? "You don't have access to this" : "Your role doesn't allow changes here. Ask an admin." });
  };

module.exports = { MODULES, ROLES, permsOf, permit };
