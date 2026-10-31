import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import Icon from "./Icon";

/* ---------- Toasts ---------- */
const listeners = new Set();
export const toast = (message, type = "success") => listeners.forEach((l) => l({ message, type, id: Math.random() }));

export function Toaster() {
  const [items, setItems] = useState([]);
  useEffect(() => {
    const l = (t) => {
      setItems((xs) => [...xs, t]);
      setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== t.id)), 3500);
    };
    listeners.add(l);
    return () => listeners.delete(l);
  }, []);
  return (
    <div className="toaster">
      {items.map((t) => (
        <div key={t.id} className={`toast toast-${t.type}`}>
          <Icon name={t.type === "error" ? "x" : "check"} size={16} />
          {t.message}
        </div>
      ))}
    </div>
  );
}

/* ---------- Layout bits ---------- */
export function PageHeader({ title, subtitle, children, back }) {
  return (
    <div className="page-header">
      <div>
        {back && (
          <Link to={back} className="back-link">
            ← Back
          </Link>
        )}
        <h1>{title}</h1>
        {subtitle && <p className="muted">{subtitle}</p>}
      </div>
      <div className="page-actions">{children}</div>
    </div>
  );
}

export function Spinner() {
  return (
    <div className="spinner-wrap">
      <div className="spinner" />
    </div>
  );
}

export function Empty({ icon = "doc", title, text, action }) {
  return (
    <div className="empty">
      <div className="empty-icon">
        <Icon name={icon} size={28} />
      </div>
      <h3>{title}</h3>
      {text && <p className="muted">{text}</p>}
      {action}
    </div>
  );
}

const STATUS_LABEL = {
  draft: "Draft",
  sent: "Unpaid",
  partially_paid: "Partially Paid",
  paid: "Paid",
  overdue: "Overdue",
  void: "Void",
  active: "Active",
  inactive: "Inactive",
};
export function Status({ value }) {
  return <span className={`status status-${value}`}>{STATUS_LABEL[value] || value}</span>;
}

/* ---------- Form fields ---------- */
export function Field({ label, required, hint, children, className = "" }) {
  return (
    <label className={`field ${className}`}>
      {label && (
        <span className={`field-label ${required ? "req" : ""}`}>
          {label}
        </span>
      )}
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export function SearchBox({ value, onChange, placeholder = "Search" }) {
  return (
    <div className="searchbox">
      <Icon name="search" size={16} />
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />
    </div>
  );
}

export function useDebounced(value, ms = 250) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function Confirm({ open, title, text, confirmLabel = "Delete", onConfirm, onCancel, danger = true }) {
  if (!open) return null;
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        <p className="muted">{text}</p>
        <div className="modal-actions">
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button className={`btn ${danger ? "btn-danger" : "btn-primary"}`} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
