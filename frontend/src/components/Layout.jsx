import { useState } from "react";
import { Navigate, NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import CompanySwitcher from "./CompanySwitcher";
import Logo from "./Logo";
import Icon from "./Icon";
import { useAuth } from "../lib/auth";
import TallyKeys from "./TallyKeys";
import { useClickAway } from "./ui";
import { BackMemory, markJump } from "../lib/backNav";
import DeviceGate from "./DeviceGate";

const NAV = [
  { to: "/", label: "Home", icon: "home", end: true },
  { to: "/inbox", label: "Inbox", icon: "chat", mod: "inbox" },
  {
    label: "Items",
    icon: "box",
    mod: ["items.items", "items.adjustments", "items.transfer_orders", "inventory"],
    children: [
      { to: "/items", label: "Items", mod: "items.items" },
      { to: "/inventory", label: "Inventory", mod: "inventory" },
      { to: "/inventory-adjustments", label: "Inventory Adjustments", mod: "items.adjustments" },
      { to: "/transfer-orders", label: "Transfer Orders", mod: "items.transfer_orders" },
    ],
  },
  {
    label: "Sales",
    icon: "sales",
    mod: "@children",
    children: [
      { to: "/customers", label: "Customers", mod: "sales.customers" },
      { to: "/quotes", label: "Quotes", mod: "sales.quotes" },
      { to: "/sales-orders", label: "Sales Orders", mod: "sales.sales_orders" },
      { to: "/invoices", label: "Invoices", mod: "sales.invoices" },
      { to: "/recurring-invoices", label: "Recurring Invoices", mod: "sales.recurring" },
      { to: "/payments", label: "Payments Received", mod: "sales.payments" },
      { to: "/credit-notes", label: "Credit Notes", mod: "sales.credit_notes" },
      { to: "/sales-ledgers", label: "Sales Ledgers", mod: "sales.ledgers" },
      { to: "/amazon", label: "Amazon Sales", mod: "sales.amazon" },
      { to: "/flipkart-sales", label: "Flipkart Sales", mod: "sales.flipkart" },
      { to: "/pepperfry-sales", label: "Pepperfry Sales", mod: "sales.pepperfry" },
    ],
  },
  {
    label: "Purchases",
    icon: "cart",
    mod: "@children",
    children: [
      { to: "/vendors", label: "Vendors", mod: "purchases.vendors" },
      { to: "/expenses", label: "Expenses", mod: "purchases.expenses" },
      { to: "/recurring-expenses", label: "Recurring Expenses", mod: "purchases.recurring" },
      { to: "/purchase-orders", label: "Purchase Orders", mod: "purchases.purchase_orders" },
      { to: "/bills", label: "Bills", mod: "purchases.bills" },
      { to: "/recurring-bills", label: "Recurring Bills", mod: "purchases.recurring" },
      { to: "/payments-made", label: "Payments Made", mod: "purchases.payments_made" },
      { to: "/vendor-credits", label: "Vendor Credits", mod: "purchases.vendor_credits" },
      { to: "/purchase-ledgers", label: "Purchase Ledgers", mod: "purchases.ledgers" },
    ],
  },
  {
    label: "Store",
    icon: "bag",
    mod: ["store_orders", "store_shipping", "store_returns", "store_settings", "store_sellers"],
    children: [
      { to: "/shopify-orders", label: "Orders", mod: ["store_orders", "store_shipping"] },
      { to: "/awb-scan", label: "Scan AWB", mod: "store_shipping" },
      { to: "/returns-scan", label: "Scan Returns", mod: "store_returns" },
      { to: "/package-types", label: "Package Types", mod: ["store_shipping", "store_settings", "store_orders"] },
      { to: "/shipping-calculator", label: "Shipping Calculator", mod: ["store_shipping", "store_settings", "store_orders"] },
      { to: "/sellers", label: "Sellers", mod: "store_sellers" },
      { to: "/amazon-settings", label: "Amazon", mod: "store_settings" },
      { to: "/flipkart-settings", label: "Flipkart", mod: "store_settings" },
      { to: "/shopify-settings", label: "Settings", mod: "store_settings" },
    ],
  },
  {
    label: "Time Tracking",
    icon: "clock",
    mod: "@children",
    children: [
      { to: "/projects", label: "Projects", mod: "sales.projects" },
      { to: "/timesheet", label: "Timesheet", mod: "sales.projects" },
    ],
  },
  { to: "/banking", label: "Banking", icon: "bank", mod: "banking" },
  {
    label: "Accountant",
    icon: "book",
    mod: "@children",
    children: [
      { to: "/journals", label: "Manual Journals", mod: "accountant.journals" },
      { to: "/chart-of-accounts", label: "Chart of Accounts", mod: "accountant.accounts" },
      { to: "/fixed-assets", label: "Fixed Assets", mod: "accountant.fixed_assets" },
      { to: "/budgets", label: "Budgets", mod: "accountant.budgets" },
    ],
  },
  {
    label: "GST",
    icon: "doc",
    mod: "gst",
    children: [
      { to: "/gst", label: "GST Returns" },
      { to: "/itc", label: "Input Tax Credit" },
      { to: "/gst/reconcile", label: "GSTR-2B Reconciliation" },
      { to: "/e-invoices", label: "e-Invoices" },
      { to: "/e-way-bills", label: "e-Way Bills" },
    ],
  },
  {
    label: "Marketing",
    icon: "megaphone",
    mod: "marketing",
    children: [
      { to: "/marketing/campaigns", label: "Campaigns" },
      { to: "/marketing/automations", label: "Automations" },
      { to: "/marketing/auto-replies", label: "Auto-replies" },
      { to: "/marketing/integrations", label: "Integrations" },
    ],
  },
  { to: "/reports", label: "Reports", icon: "chart", mod: "reports" },
];
// A group shown when any of its pages is.
for (const n of NAV) if (n.mod === "@children") n.mod = n.children.map((c) => c.mod);
const HOME_MODS = ["sales", "purchases", "reports", "accountant", "banking"];

// Which permission module a page belongs to.
const PATH_MODULES = [
  ["/items", "items.items"],
  ["/inventory-adjustments", "items.adjustments"],
  ["/transfer-orders", "items.transfer_orders"],
  ["/locations", "settings"],
  ["/currencies", "settings"],
  ["/import", "settings"],
  ["/customers", "sales.customers"],
  ["/sales-ledgers", "sales.ledgers"],
  ["/purchase-ledgers", "purchases.ledgers"],
  ["/shopify-orders", ["store_orders", "store_shipping"]],
  ["/shopify-settings", ["store_settings", "store_orders"]],
  ["/amazon-settings", "store_settings"],
  ["/flipkart-settings", "store_settings"],
  ["/returns-scan", "store_returns"],
  ["/awb-scan", "store_shipping"],
  ["/package-types", ["store_shipping", "store_settings", "store_orders"]],
  ["/shipping-calculator", ["store_shipping", "store_settings", "store_orders"]],
  ["/sellers", "store_sellers"],
  ["/inventory", "inventory"],
  ["/gst", "gst"],
  ["/itc", ["gst", "purchases", "accountant", "reports"]],
  ["/flipkart-sales", "sales.flipkart"],
  ["/pepperfry-sales", "sales.pepperfry"],
  ["/amazon", "sales.amazon"],
  ["/quotes", "sales.quotes"],
  ["/sales-orders", "sales.sales_orders"],
  ["/invoices", "sales.invoices"],
  ["/recurring-invoices", "sales.recurring"],
  ["/payments", "sales.payments"],
  ["/credit-notes", "sales.credit_notes"],
  ["/e-invoices", "gst"],
  ["/e-way-bills", "gst"],
  ["/projects", "sales.projects"],
  ["/timesheet", "sales.projects"],
  ["/vendors", "purchases.vendors"],
  ["/expenses", "purchases.expenses"],
  ["/recurring-expenses", "purchases.recurring"],
  ["/purchase-orders", "purchases.purchase_orders"],
  ["/bills", "purchases.bills"],
  ["/recurring-bills", "purchases.recurring"],
  ["/payments-made", "purchases.payments_made"],
  ["/vendor-credits", "purchases.vendor_credits"],
  ["/banking", "banking"],
  ["/journals", "accountant.journals"],
  ["/budgets", "accountant.budgets"],
  ["/fixed-assets", "accountant.fixed_assets"],
  ["/chart-of-accounts", "accountant.accounts"],
  ["/reports", "reports"],
  ["/inbox", "inbox"],
  ["/marketing", "marketing"],
  ["/settings", "settings"],
  ["/users", "settings"],
  ["/security", "settings"],
];
// Pages outside the company role permissions (only for the OrdexaGo superadmin).
const SUPER_PATHS = ["/superadmin"];
export const moduleOf = (path) => (PATH_MODULES.find(([p]) => path === p || path.startsWith(p + "/")) || [])[1];
const RANK = { none: 0, view: 1, full: 2 };
// Best access across one module or several.
export const levelOf = (user, mod) => (Array.isArray(mod) ? mod : [mod]).map((m) => user?.permissions?.[m] || "none").sort((a, b) => RANK[b] - RANK[a])[0];
export const can = (user, mod, need = "view") => {
  const lvl = levelOf(user, mod);
  return need === "full" ? lvl === "full" : lvl !== "none";
};
// Where a user lands: their role's home page, else the first page they can open.
export const homeFor = (user) => {
  if (user?.home) return user.home;
  if (can(user, HOME_MODS)) return "/";
  for (const n of NAV) {
    if (n.children) {
      const c = n.children.find((c) => can(user, c.mod || n.mod));
      if (c && (!n.mod || can(user, n.mod))) return c.to;
    } else if (n.mod && can(user, n.mod)) return n.to;
  }
  return "/no-access";
};

function Soon() {
  return <span className="soon">Soon</span>;
}

function Group({ group, onNavigate }) {
  const { user } = useAuth();
  const location = useLocation();
  const active = group.children.some((c) => location.pathname.startsWith(c.to));
  const [open, setOpen] = useState(active || group.label === "Sales");
  return (
    <div className={`nav-group ${open ? "open" : ""}`}>
      <button className={`nav-item ${active ? "has-active" : ""}`} onClick={() => setOpen(!open)}>
        <Icon name={group.icon} />
        <span>{group.label}</span>
        <Icon name="chevron" size={14} className="nav-caret" />
      </button>
      {open && (
        <div className="nav-children">
          {group.children.filter((c) => !c.mod || can(user, c.mod)).map((c) => (
            <NavLink key={c.to} to={c.to} className="nav-child" onClick={onNavigate}>
              {c.label}
              {c.soon && <Soon />}
            </NavLink>
          ))}
        </div>
      )}
    </div>
  );
}

export default function Layout() {
  const { user, organization, signOut, subscription } = useAuth();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const profileRef = useClickAway(profileOpen, () => setProfileOpen(false));
  // Sidebar links are jumps (Back from the page they open goes up its own hierarchy).
  const close = () => {
    markJump();
    setMenuOpen(false);
  };
  const location = useLocation();
  const mod = location.pathname === "/" ? HOME_MODS : moduleOf(location.pathname);
  const isSuper = SUPER_PATHS.some((p) => location.pathname.startsWith(p));
  const isSeller = user?.role === "seller";
  const sellerPage = location.pathname === "/seller" || location.pathname.startsWith("/seller/");
  const level = sellerPage ? (isSeller ? "full" : "none") : isSuper ? (user?.superadmin ? "full" : "none") : mod ? levelOf(user, mod) : "full";
  // A marketplace seller sees only their dashboard.
  const nav = isSeller ? [{ to: "/seller", label: "My orders & stock", icon: "bag", end: true }] : NAV.filter((n) => (n.to === "/" ? can(user, HOME_MODS) : !n.mod || can(user, n.mod)));
  // Roles without the dashboard (e.g. Returns Desk) go straight to their page.
  if (location.pathname === "/" && level === "none" && homeFor(user) !== "/") return <Navigate to={homeFor(user)} replace />;

  return (
    <div className={`app ${menuOpen ? "menu-open" : ""}`}>
      <aside className="sidebar">
        <div className="sidebar-brand">
          <Logo size={30} light tagline />
        </div>
        <nav className="nav">
          {nav.map((n) =>
            n.children ? (
              <Group key={n.label} group={n} onNavigate={close} />
            ) : (
              <NavLink key={n.to} to={n.to} end={n.end} className="nav-item" onClick={close}>
                <Icon name={n.icon} />
                <span>{n.label}</span>
                {n.soon && <Soon />}
              </NavLink>
            )
          )}
        </nav>
        {user?.superadmin && (
          <NavLink to="/superadmin" className="nav-item nav-settings" onClick={close}>
            <Icon name="users" />
            <span>Superadmin</span>
          </NavLink>
        )}
        {can(user, "settings") && (
          <>
            <NavLink to="/users" className="nav-item nav-settings" onClick={close}>
              <Icon name="users" />
              <span>Users & Roles</span>
            </NavLink>
            {(user?.superadmin || user?.role === "admin") && (
              <NavLink to="/security" className="nav-item" onClick={close}>
                <Icon name="shield" />
                <span>Security</span>
              </NavLink>
            )}
            <NavLink to="/locations" className="nav-item" onClick={close}>
              <Icon name="bank" />
              <span>Branches & Warehouses</span>
            </NavLink>
            <NavLink to="/currencies" className="nav-item" onClick={close}>
              <Icon name="chart" />
              <span>Currencies</span>
            </NavLink>
            <NavLink to="/import" className="nav-item" onClick={close}>
              <Icon name="down" />
              <span>Import Data</span>
            </NavLink>
            <NavLink to="/settings" className="nav-item" onClick={close}>
              <Icon name="settings" />
              <span>Settings</span>
            </NavLink>
          </>
        )}
      </aside>
      <div className="sidebar-scrim" onClick={close} />

      <div className="main">
        <header className="topbar">
          <button className="icon-btn menu-btn" onClick={() => setMenuOpen(true)} aria-label="Menu">
            <Icon name="menu" />
          </button>
          <CompanySwitcher />
          <div className="topbar-right">
            {can(user, "sales.invoices", "full") && (
              <button className="btn btn-primary btn-sm keep" onClick={() => (markJump(), navigate("/invoices/new"))}>
                <Icon name="plus" size={16} /> <span className="hide-sm">New Invoice</span>
              </button>
            )}
            <div className="profile" ref={profileRef}>
              <button className="avatar" onClick={() => setProfileOpen(!profileOpen)} aria-label="Account">
                {(user?.name || "?").slice(0, 1).toUpperCase()}
              </button>
              {profileOpen && (
                <div className="profile-menu">
                  <div className="profile-head">
                    <strong>{user?.name}</strong>
                    <span className="muted">{user?.email}</span>
                  </div>
                  <button
                    onClick={() => {
                      setProfileOpen(false);
                      navigate("/settings");
                    }}
                  >
                    <Icon name="settings" size={16} /> Organization settings
                  </button>
                  <button
                    onClick={() => {
                      setProfileOpen(false);
                      navigate("/account");
                    }}
                  >
                    <Icon name="shield" size={16} /> Password & two-step login
                  </button>
                  <button
                    onClick={() => {
                      signOut();
                      navigate("/login");
                    }}
                  >
                    <Icon name="logout" size={16} /> Sign out
                  </button>
                </div>
              )}
            </div>
          </div>
        </header>
        <TallyKeys nav={nav} />
        <BackMemory />
        <DeviceGate />
        <main className={`content ${level === "view" ? "readonly" : ""}`}>
          {level === "none" ? (
            <div className="card center no-access">
              <h3>You don't have access to this page</h3>
              <p className="muted">Your role is {user?.roleLabel || user?.role}. Ask an admin if you need access.</p>
            </div>
          ) : (
            <>
              {subscription?.state === "grace" && (
                <div className="alert alert-error">
                  <strong>Subscription expired.</strong> {subscription.message} Contact OrdexaGo at <a href="mailto:help@ordexago.com">help@ordexago.com</a>.
                </div>
              )}
              {subscription?.state === "active" && subscription.daysLeft <= 7 && (
                <div className="alert readonly-banner">Your OrdexaGo subscription ends in {subscription.daysLeft} day{subscription.daysLeft > 1 ? "s" : ""}. Contact OrdexaGo at help@ordexago.com to renew.</div>
              )}
              {level === "view" && <div className="alert readonly-banner">View only — your role can see this but not change it.</div>}
              <Outlet />
            </>
          )}
        </main>
      </div>
    </div>
  );
}
