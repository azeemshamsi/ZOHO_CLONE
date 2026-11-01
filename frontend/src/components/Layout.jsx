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
    children: [
      { to: "/items", label: "Items" },
      { to: "/inventory-adjustments", label: "Inventory Adjustments" },
    ],
  },
  {
    label: "Sales",
    icon: "sales",
    children: [
      { to: "/customers", label: "Customers" },
      { to: "/quotes", label: "Quotes" },
      { to: "/sales-orders", label: "Sales Orders" },
      { to: "/invoices", label: "Invoices" },
      { to: "/payments", label: "Payments Received" },
      { to: "/credit-notes", label: "Credit Notes" },
    ],
  },
  {
    label: "Purchases",
    icon: "cart",
    children: [
      { to: "/vendors", label: "Vendors" },
      { to: "/expenses", label: "Expenses" },
      { to: "/purchase-orders", label: "Purchase Orders" },
      { to: "/bills", label: "Bills" },
      { to: "/payments-made", label: "Payments Made" },
      { to: "/vendor-credits", label: "Vendor Credits" },
    ],
  },
  { to: "/banking", label: "Banking", icon: "bank" },
  {
    label: "Accountant",
    icon: "book",
    children: [
      { to: "/journals", label: "Manual Journals" },
      { to: "/chart-of-accounts", label: "Chart of Accounts" },
    ],
  },
  { to: "/reports", label: "Reports", icon: "chart" },
];

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

  return (
    <div className={`app ${menuOpen ? "menu-open" : ""}`}>
      <aside className="sidebar">
        <div className="sidebar-brand">
          <Logo size={30} light tagline />
        </div>
        <nav className="nav">
          {NAV.map((n) =>
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
        <NavLink to="/settings" className="nav-item nav-settings" onClick={close}>
          <Icon name="settings" />
          <span>Settings</span>
        </NavLink>
      </aside>
      <div className="sidebar-scrim" onClick={close} />

      <div className="main">
        <header className="topbar">
          <button className="icon-btn menu-btn" onClick={() => setMenuOpen(true)} aria-label="Menu">
            <Icon name="menu" />
          </button>
          <div className="topbar-org">{organization?.name}</div>
          <div className="topbar-right">
            <button className="btn btn-primary btn-sm" onClick={() => navigate("/invoices/new")}>
              <Icon name="plus" size={16} /> New Invoice
            </button>
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
        <main className="content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
