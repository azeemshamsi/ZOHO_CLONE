import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Modal, toast } from "./ui";
import api from "../lib/api";

/**
 * Tally keyboard shortcuts across OrdexaGo.
 *  Esc            back / close the open window (asks before leaving a form being edited)
 *  Ctrl+A         accept: save the form or the open window
 *  Alt+G, Ctrl+G  Go To: jump to any page or report by typing its name
 *  F4 Contra (Banking) · F5 Payment · F6 Receipt · F7 Journal · F8 Sales · F9 Purchase
 *  Ctrl+F8 Credit Note · Ctrl+F9 Debit Note
 *  Alt+P print · Alt+D delete · Alt+C create (new of the current list)
 *  Gateway (when not typing): D Day Book · B Balance Sheet · P Profit & Loss · T Trial Balance · L Ledgers
 *  Page Up / Page Down   previous (earlier) / next (later) voucher of the same kind, on a voucher's page
 *  F2             change the date: jumps to the date field
 *  Alt+F2         change period on reports / ledger statements (the picker opens a From–To box)
 *  Enter          next field on a form (as in Tally); Ctrl+A saves
 *  Ctrl+/         this list
 */
// Voucher pages → the list they page through (newest first, as the API returns them).
const PAGED = {
  invoices: "/invoices",
  bills: "/bills",
  "credit-notes": "/credit-notes",
  "vendor-credits": "/vendor-credits",
  journals: "/journals",
  payments: "/payments",
  "payments-made": "/vendor-payments",
  quotes: "/quotes",
  "sales-orders": "/sales-orders",
  "purchase-orders": "/purchase-orders",
};
const listCache = new Map(); // kind → ids, newest first
async function neighbour(kind, id, dir) {
  const load = async () => {
    const { data } = await api.get(PAGED[kind]);
    const ids = (Array.isArray(data) ? data : data.rows || []).map((d) => String(d._id));
    listCache.set(kind, ids);
    return ids;
  };
  let ids = listCache.get(kind) || (await load());
  if (!ids.includes(id)) ids = await load();
  const i = ids.indexOf(id);
  if (i < 0) return null;
  return dir === "earlier" ? ids[i + 1] : ids[i - 1];
}
const focusables = (root) =>
  [...root.querySelectorAll("input, select, textarea, button[type=submit]")].filter(
    (el) => visible(el) && el.tabIndex !== -1 && !el.readOnly && el.type !== "hidden" && el.type !== "file" && !el.closest(".ss-list") && !el.classList.contains("ss-req")
  );
const VOUCHERS = {
  F4: ["/banking", "Contra (Banking)"],
  F5: ["/payments-made/new", "Payment"],
  F6: ["/payments/new", "Receipt"],
  F7: ["/journals/new", "Journal"],
  F8: ["/invoices/new", "Sales (Invoice)"],
  F9: ["/bills/new", "Purchase (Bill)"],
  "Ctrl+F8": ["/credit-notes/new", "Credit Note"],
  "Ctrl+F9": ["/vendor-credits/new", "Debit Note (Vendor Credit)"],
};
const GATEWAY = {
  d: ["/reports/day-book", "Day Book"],
  b: ["/reports/balance-sheet", "Balance Sheet"],
  p: ["/reports/profit-and-loss", "Profit & Loss"],
  t: ["/reports/trial-balance", "Trial Balance"],
  l: ["/chart-of-accounts", "Ledgers (Chart of Accounts)"],
};
const REPORTS = [
  ["/reports/day-book", "Day Book"],
  ["/reports/trial-balance", "Trial Balance"],
  ["/reports/profit-and-loss", "Profit & Loss"],
  ["/reports/balance-sheet", "Balance Sheet"],
  ["/reports/general-ledger", "General Ledger"],
  ["/reports/detailed-general-ledger", "Detailed General Ledger"],
  ["/reports/cash-flow", "Cash Flow"],
  ["/reports/ar-aging-details", "Receivables Ageing"],
  ["/reports/ap-aging-details", "Payables Ageing"],
  ["/reports/customer-balances", "Customer Balances (Sundry Debtors)"],
  ["/reports/vendor-balances", "Vendor Balances (Sundry Creditors)"],
  ["/reports/sales-summary", "Sales Register"],
  ["/reports/inventory-summary", "Stock Summary"],
  ["/reports/tax-summary", "GST Summary"],
];

const typing = (el) => !!el && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName));
const topModal = () => [...document.querySelectorAll(".modal-backdrop")].pop();
const visible = (el) => !!el && !el.disabled && el.offsetParent !== null;
const buttonByText = (root, rx) => [...root.querySelectorAll("button, a.btn")].find((b) => visible(b) && rx.test((b.textContent || "").trim()));

export default function TallyKeys({ nav = [] }) {
  const navigate = useNavigate();
  const loc = useLocation();
  const [goto, setGoto] = useState(false);
  const [help, setHelp] = useState(false);
  const locRef = useRef(loc);
  locRef.current = loc;

  useEffect(() => {
    const go = (to) => navigate(to);
    const onKey = (e) => {
      if (e.defaultPrevented) return;
      const key = e.key;
      const modal = topModal();
      const t = e.target;

      // Esc: close the open window, else go back (Tally's quit).
      if (key === "Escape") {
        if (document.querySelector(".ss-list")) return; // an open dropdown closes itself first
        if (goto || help) return;
        if (modal) {
          e.preventDefault();
          const close = modal.querySelector(".modal-head .icon-btn") || buttonByText(modal, /^(cancel|back|close|no)$/i);
          if (close) close.click();
          else modal.click();
          return;
        }
        if (typing(t)) t.blur();
        const path = locRef.current.pathname;
        if (path === "/") return;
        if (/\/(new|edit)$/.test(path) && !window.confirm("Quit without saving?")) return;
        e.preventDefault();
        if (window.history.length > 1) navigate(-1);
        else navigate("/");
        return;
      }

      // Ctrl+A: accept (save).
      if (e.ctrlKey && !e.altKey && key.toLowerCase() === "a") {
        const scope = modal || document.querySelector("main");
        const form = modal ? null : scope?.querySelector("form");
        const primary = modal ? [...modal.querySelectorAll(".modal-actions .btn-primary, .modal-actions .btn-danger")].find(visible) : null;
        if (primary) {
          e.preventDefault();
          primary.click();
        } else if (form && /\/(new|edit)$|settings/.test(locRef.current.pathname)) {
          e.preventDefault();
          form.requestSubmit ? form.requestSubmit() : form.submit();
        }
        return;
      }

      // Page Up / Page Down: previous (earlier) / next (later) voucher.
      if ((key === "PageUp" || key === "PageDown") && !modal && !typing(t)) {
        const m = locRef.current.pathname.match(/^\/([a-z-]+)\/([0-9a-f]{24})$/);
        if (m && PAGED[m[1]]) {
          e.preventDefault();
          neighbour(m[1], m[2], key === "PageUp" ? "earlier" : "later")
            .then((next) => (next ? go(`/${m[1]}/${next}`) : toast(key === "PageUp" ? "This is the first voucher" : "This is the last voucher")))
            .catch(() => {});
          return;
        }
      }

      // Ctrl+H change view, Alt+F5 detailed / condensed: pages with views listen for these.
      if ((e.ctrlKey && !e.altKey && key.toLowerCase() === "h") || (e.altKey && key === "F5")) {
        if (document.querySelector("[data-views]")) {
          e.preventDefault();
          window.dispatchEvent(new Event(key === "F5" ? "tally:detail" : "tally:view"));
        } else if (key === "F5") {
          e.preventDefault();
          toast("Alt+F5 (detailed view) works on ledger lists");
        }
        return;
      }

      // Alt+F2: change period (reports and account statements).
      if (key === "F2" && e.altKey && !e.ctrlKey) {
        e.preventDefault();
        if (document.querySelector("[data-period]")) window.dispatchEvent(new Event("tally:period"));
        else toast("Alt+F2 changes the period on reports and ledger statements");
        return;
      }

      // F2: change the date.
      if (key === "F2" && !e.ctrlKey && !e.altKey) {
        const root = modal || document.querySelector("main");
        const d = [...(root?.querySelectorAll('input[type="date"]') || [])].find(visible);
        if (d) {
          e.preventDefault();
          d.focus();
          try {
            d.showPicker?.();
          } catch {}
        }
        return;
      }

      // Enter: next field on a form (Tally). Not in text areas, buttons, or an open dropdown.
      if (key === "Enter" && !e.ctrlKey && !e.altKey && !e.shiftKey && t && ["INPUT", "SELECT"].includes(t.tagName) && !["checkbox", "radio", "submit", "button"].includes(t.type)) {
        const form = t.closest("form") || t.closest(".modal");
        const editing = /\/(new|edit)$/.test(locRef.current.pathname) || !!t.closest(".modal");
        if (form && editing && !document.querySelector(".ss-list")) {
          const list = focusables(form);
          const i = list.indexOf(t);
          const next = list[i + 1];
          if (i >= 0 && next) {
            e.preventDefault();
            next.focus();
            if (next.select && next.tagName === "INPUT") next.select();
          }
        }
        return;
      }

      // Go To.
      if ((e.altKey || e.ctrlKey) && key.toLowerCase() === "g") {
        e.preventDefault();
        setGoto(true);
        return;
      }
      if (e.ctrlKey && key === "/") {
        e.preventDefault();
        setHelp(true);
        return;
      }

      // Voucher keys.
      const fk = /^F\d+$/.test(key) ? (e.ctrlKey ? `Ctrl+${key}` : e.altKey || e.shiftKey ? "" : key) : "";
      if (fk && VOUCHERS[fk]) {
        e.preventDefault();
        go(VOUCHERS[fk][0]);
        return;
      }

      // Alt+P print, Alt+D delete, Alt+C create.
      if (e.altKey && !e.ctrlKey) {
        const k = key.toLowerCase();
        const main = modal || document.querySelector("main");
        if (k === "p") {
          e.preventDefault();
          const b = buttonByText(main, /^(print|pdf|download pdf|print \/ pdf)/i);
          if (b) b.click();
          else window.print();
          return;
        }
        if (k === "d") {
          const b = buttonByText(main, /^delete\b/i);
          if (b) {
            e.preventDefault();
            b.click();
          }
          return;
        }
        if (k === "c") {
          const b = buttonByText(main, /^(\+\s*)?new\b/i);
          if (b) {
            e.preventDefault();
            b.click();
          }
          return;
        }
      }

      // Gateway letters, only when not typing and no window is open.
      if (!e.ctrlKey && !e.altKey && !e.metaKey && !modal && !typing(t) && GATEWAY[key.toLowerCase()] && key.length === 1) {
        e.preventDefault();
        go(GATEWAY[key.toLowerCase()][0]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [goto, help, navigate]);

  return (
    <>
      {goto && <GoTo nav={nav} onClose={() => setGoto(false)} onGo={(to) => (setGoto(false), navigate(to))} />}
      {help && <Help onClose={() => setHelp(false)} />}
    </>
  );
}

function GoTo({ nav, onClose, onGo }) {
  const [q, setQ] = useState("");
  const [i, setI] = useState(0);
  const all = useMemo(() => {
    const pages = [];
    for (const n of nav) {
      if (n.children) for (const c of n.children) pages.push([c.to, `${c.label}`, n.label]);
      else if (n.to) pages.push([n.to, n.label, ""]);
    }
    for (const [k, [to, l]] of Object.entries(VOUCHERS)) pages.push([to, `${l} — new`, k]);
    for (const [to, l] of REPORTS) pages.push([to, l, "Report"]);
    const seen = new Set();
    return pages.filter(([to, l]) => !seen.has(to + l) && seen.add(to + l));
  }, [nav]);
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const list = all.filter(([, l, g]) => words.every((w) => `${l} ${g}`.toLowerCase().includes(w))).slice(0, 12);
  return (
    <Modal open title="Go To" onClose={onClose}>
      <input
        autoFocus
        value={q}
        placeholder="Type a page, voucher or report…"
        onChange={(e) => (setQ(e.target.value), setI(0))}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") (e.preventDefault(), setI(Math.min(i + 1, list.length - 1)));
          if (e.key === "ArrowUp") (e.preventDefault(), setI(Math.max(i - 1, 0)));
          if (e.key === "Enter" && list[i]) onGo(list[i][0]);
          if (e.key === "Escape") (e.preventDefault(), onClose());
        }}
        style={{ width: "100%" }}
      />
      <div style={{ marginTop: 8 }}>
        {list.map(([to, l, g], k) => (
          <div key={to + l} onMouseDown={() => onGo(to)} onMouseEnter={() => setI(k)} style={{ padding: "7px 10px", borderRadius: 6, cursor: "pointer", background: k === i ? "var(--blue-50, #eef4ff)" : "transparent", display: "flex", justifyContent: "space-between" }}>
            <span>{l}</span>
            <span className="muted small">{g}</span>
          </div>
        ))}
        {!list.length && <p className="muted small">Nothing matches.</p>}
      </div>
    </Modal>
  );
}

function Help({ onClose }) {
  useEffect(() => {
    const k = (e) => e.key === "Escape" && (e.preventDefault(), onClose());
    window.addEventListener("keydown", k, true);
    return () => window.removeEventListener("keydown", k, true);
  }, []);
  const rows = [
    ["Esc", "Back / close the open window (asks before leaving a form)"],
    ["Ctrl+A", "Accept — save the form or the open window"],
    ["Alt+G or Ctrl+G", "Go To any page, voucher or report"],
    ...Object.entries(VOUCHERS).map(([k, [, l]]) => [k, l]),
    ["Page Up / Page Down", "Previous (earlier) / next (later) voucher, on a voucher's page"],
    ["F2", "Change the date (jumps to the date field)"],
    ["Alt+F2", "Change period (reports, ledger statements)"],
    ["Ctrl+H", "Change view: summary / detailed / transactions (ledger lists)"],
    ["Alt+F5", "Detailed / condensed (ledger lists)"],
    ["Enter", "Next field on a form; Ctrl+A saves"],
    ["Alt+C", "Create new (on a list)"],
    ["Alt+P", "Print / PDF"],
    ["Alt+D", "Delete"],
    ...Object.entries(GATEWAY).map(([k, [, l]]) => [k.toUpperCase(), `${l} (when not typing)`]),
    ["Ctrl+/", "This list"],
  ];
  return (
    <Modal open title="Keyboard shortcuts (Tally)" onClose={onClose}>
      <table className="table compact">
        <tbody>
          {rows.map(([k, l]) => (
            <tr key={k}>
              <td style={{ width: 150 }}>
                <kbd style={{ fontFamily: "monospace", background: "var(--bg-soft, #f3f4f6)", border: "1px solid var(--border, #e5e7eb)", borderRadius: 4, padding: "1px 6px" }}>{k}</kbd>
              </td>
              <td>{l}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Modal>
  );
}
