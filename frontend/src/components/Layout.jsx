import { useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import Logo from "./Logo";
import Icon from "./Icon";
import { useAuth } from "../lib/auth";

const NAV = [
  { to: "/", label: "Home", icon: "home", end: true },
  {
    label: "Items",
    icon: "box",
    mod: "items",
    children: [
      { to: "/items", label: "Items" },
      { to: "/inventory-adjustments", label: "Inventory Adjustments" },
      { to: "/transfer-orders", label: "Transfer Orders" },
    ],
  },
  {
    label: "Sales",
    icon: "sales",
    mod: "sales",
    children: [
      { to: "/customers", label: "Customers" },
      { to: "/quotes", label: "Quotes" },
      { to: "/sales-orders", label: "Sales Orders" },
      { to: "/invoices", label: "Invoices" },
      { to: "/recurring-invoices", label: "Recurring Invoices" },
      { to: "/payments", label: "Payments Received" },
      { to: "/credit-notes", label: "Credit Notes" },
      { to: "/e-invoices", label: "e-Invoices" },
      { to: "/e-way-bills", label: "e-Way Bills" },
    ],
  },
  {
    label: "Purchases",
    icon: "cart",
    mod: "purchases",
    children: [
      { to: "/vendors", label: "Vendors" },
      { to: "/expenses", label: "Expenses" },
      { to: "/recurring-expenses", label: "Recurring Expenses" },
      { to: "/purchase-orders", label: "Purchase Orders" },
      { to: "/bills", label: "Bills" },
      { to: "/recurring-bills", label: "Recurring Bills" },
      { to: "/payments-made", label: "Payments Made" },
      { to: "/vendor-credits", label: "Vendor Credits" },
    ],
  },
  {
    label: "Time Tracking",
    icon: "clock",
    mod: "sales",
    children: [
      { to: "/projects", label: "Projects" },
      { to: "/timesheet", label: "Timesheet" },
    ],
  },
  { to: "/banking", label: "Banking", icon: "bank", mod: "banking" },
  {
    label: "Accountant",
    icon: "book",
    mod: "accountant",
    children: [
      { to: "/journals", label: "Manual Journals" },
      { to: "/chart-of-accounts", label: "Chart of Accounts" },
      { to: "/fixed-assets", label: "Fixed Assets" },
      { to: "/budgets", label: "Budgets" },
    ],
  },
  { to: "/reports", label: "Reports", icon: "chart", mod: "reports" },
];

// Which permission module a page belongs to.
const PATH_MODULES = [
  ["/items", "items"],
  ["/inventory-adjustments", "items"],
  ["/transfer-orders", "items"],
  ["/locations", "settings"],
  ["/currencies", "settings"],
  ["/customers", "sales"],
  ["/quotes", "sales"],
  ["/sales-orders", "sales"],
  ["/invoices", "sales"],
  ["/recurring-invoices", "sales"],
  ["/payments", "sales"],
  ["/credit-notes", "sales"],
  ["/e-invoices", "sales"],
  ["/e-way-bills", "sales"],
  ["/projects", "sales"],
  ["/timesheet", "sales"],
  ["/vendors", "purchases"],
  ["/expenses", "purchases"],
  ["/recurring-expenses", "purchases"],
  ["/purchase-orders", "purchases"],
  ["/bills", "purchases"],
  ["/recurring-bills", "purchases"],
  ["/payments-made", "purchases"],
  ["/vendor-credits", "purchases"],
  ["/banking", "banking"],
  ["/journals", "accountant"],
  ["/budgets", "accountant"],
  ["/fixed-assets", "accountant"],
  ["/chart-of-accounts", "accountant"],
  ["/reports", "reports"],
  ["/settings", "settings"],
  ["/users", "settings"],
];
export const moduleOf = (path) => (PATH_MODULES.find(([p]) => path === p || path.startsWith(p + "/")) || [])[1];
export const can = (user, mod, need = "view") => {
  const lvl = user?.permissions?.[mod] || "none";
  return need === "full" ? lvl === "full" : lvl !== "none";
};

function Soon() {
  return <span className="soon">Soon</span>;
}

function Group({ group, onNavigate }) {
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
          {group.children.map((c) => (
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
  const { user, organization, signOut } = useAuth();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const close = () => setMenuOpen(false);
  const location = useLocation();
  const mod = moduleOf(location.pathname);
  const level = mod ? user?.permissions?.[mod] || "none" : "full";
  const nav = NAV.filter((n) => !n.mod || can(user, n.mod));

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
        {can(user, "settings") && (
          <>
            <NavLink to="/users" className="nav-item nav-settings" onClick={close}>
              <Icon name="users" />
              <span>Users & Roles</span>
            </NavLink>
            <NavLink to="/locations" className="nav-item" onClick={close}>
              <Icon name="bank" />
              <span>Branches & Warehouses</span>
            </NavLink>
            <NavLink to="/currencies" className="nav-item" onClick={close}>
              <Icon name="chart" />
              <span>Currencies</span>
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
          <div className="topbar-org">{organization?.name}</div>
          <div className="topbar-right">
            {can(user, "sales", "full") && (
              <button className="btn btn-primary btn-sm keep" onClick={() => navigate("/invoices/new")}>
                <Icon name="plus" size={16} /> New Invoice
              </button>
            )}
            <div className="profile">
              <button className="avatar" onClick={() => setProfileOpen(!profileOpen)} aria-label="Account">
                {(user?.name || "?").slice(0, 1).toUpperCase()}
              </button>
              {profileOpen && (
                <div className="profile-menu" onMouseLeave={() => setProfileOpen(false)}>
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
        <main className={`content ${level === "view" ? "readonly" : ""}`}>
          {level === "none" ? (
            <div className="card center no-access">
              <h3>You don't have access to this page</h3>
              <p className="muted">Your role is {user?.role}. Ask an admin if you need access.</p>
            </div>
          ) : (
            <>
              {level === "view" && <div className="alert readonly-banner">View only — your role can see this but not change it.</div>}
              <Outlet />
            </>
          )}
        </main>
      </div>
    </div>
  );
}
