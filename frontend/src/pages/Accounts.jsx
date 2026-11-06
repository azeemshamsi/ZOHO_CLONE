import { useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import api, { errMsg } from "../lib/api";
import { money, date } from "../lib/format";
import { periodRange } from "../lib/period";
import { PageHeader, Spinner, Field, toast, Modal, Confirm } from "../components/ui";
import { PeriodPicker } from "./Reports";
import Icon from "../components/Icon";

const TYPE_LABEL = { asset: "Assets", liability: "Liabilities", equity: "Equity", income: "Income", expense: "Expenses" };

function AccountModal({ open, account, onClose, onSaved }) {
  const [types, setTypes] = useState([]);
  const [f, setF] = useState({ name: "", group: "Expense", accountCode: "", description: "", active: true });
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.get("/accounts/types").then((r) => setTypes(r.data));
  }, []);
  useEffect(() => {
    if (open)
      setF(
        account
          ? { name: account.name, group: account.group, accountCode: account.accountCode || "", description: account.description || "", active: account.active !== false, ledgerKind: account.ledgerKind || "" }
          : { name: "", group: "Expense", accountCode: "", description: "", active: true, ledgerKind: "" }
      );
  }, [open, account]);
  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      if (account) await api.put(`/accounts/${account.code}`, f);
      else await api.post("/accounts", f);
      toast(account ? "Account updated" : "Account created");
      onSaved();
    } catch (err) {
      toast(errMsg(err), "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={open} onClose={onClose} title={account ? "Edit Account" : "New Account"}>
      <form className="stack" onSubmit={save}>
        <Field label="Account Type" required>
          <select value={f.group} onChange={(e) => setF({ ...f, group: e.target.value })}>
            {types.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </Field>
        <Field label="Account Name" required>
          <input required autoFocus value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        </Field>
        <Field label="Account Code">
          <input value={f.accountCode} onChange={(e) => setF({ ...f, accountCode: e.target.value })} />
        </Field>
        <Field label="Description">
          <textarea rows={2} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
        </Field>
        {(["Income", "Other Income"].includes(f.group) || ["Cost Of Goods Sold", "Expense", "Other Expense"].includes(f.group)) && (
          <Field label="Use as" hint="Sales ledgers are offered on invoices, purchase ledgers on bills">
            <select value={f.ledgerKind || ""} onChange={(e) => setF({ ...f, ledgerKind: e.target.value })}>
              <option value="">Not a sales / purchase ledger</option>
              {["Income", "Other Income"].includes(f.group) ? <option value="sales">Sales ledger</option> : <option value="purchase">Purchase ledger</option>}
            </select>
          </Field>
        )}
        {account && (
          <label className="check">
            <input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Active
          </label>
        )}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={busy}>
            Save
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function AccountList() {
  const [rows, setRows] = useState(null);
  const [type, setType] = useState("");
  const [modal, setModal] = useState(false);
  const navigate = useNavigate();
  const load = () => api.get("/accounts").then((r) => setRows(r.data));
  useEffect(() => {
    load();
  }, []);

  if (!rows) return <Spinner />;
  const shown = rows.filter((a) => !type || a.type === type);
  const types = [...new Set(shown.map((a) => a.type))];

  return (
    <>
      <PageHeader title="Chart of Accounts" subtitle="Balances include every recorded transaction. Click an account to see them.">
        <select className="select-inline" value={type} onChange={(e) => setType(e.target.value)}>
          <option value="">All Accounts</option>
          {Object.entries(TYPE_LABEL).map(([k, l]) => (
            <option key={k} value={k}>
              {l}
            </option>
          ))}
        </select>
        <button className="btn btn-primary" onClick={() => setModal(true)}>
          <Icon name="plus" size={16} /> New Account
        </button>
      </PageHeader>
      <div className="stack">
        {types.map((t) => (
          <div className="card flush" key={t}>
            <h3 className="card-title">{TYPE_LABEL[t]}</h3>
            <table className="table table-click">
              <thead>
                <tr>
                  <th>Account Name</th>
                  <th>Account Type</th>
                  <th>Code</th>
                  <th className="num">Balance</th>
                </tr>
              </thead>
              <tbody>
                {shown
                  .filter((a) => a.type === t)
                  .map((a) => (
                    <tr key={a.code} onClick={() => navigate(`/chart-of-accounts/${encodeURIComponent(a.code)}`)}>
                      <td className="strong link">
                        {a.name}
                        {a.system && <span className="tag">Built-in</span>}
                        {a.active === false && <span className="tag">Inactive</span>}
                      </td>
                      <td>{a.group}</td>
                      <td className="mono">{a.accountCode}</td>
                      <td className={`num ${a.balance < 0 ? "text-overdue" : ""}`}>{money(a.balance)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        ))}
      </div>
      <AccountModal open={modal} onClose={() => setModal(false)} onSaved={() => (setModal(false), load())} />
    </>
  );
}

const DOC_LINK = {
  Invoice: (id) => `/invoices/${id}`,
  "Customer Payment": (id) => `/payments/${id}`,
  "Credit Note": (id) => `/credit-notes/${id}`,
  "Credit Note Refund": (id) => `/credit-notes/${id}`,
  Bill: (id) => `/bills/${id}`,
  "Vendor Payment": (id) => `/payments-made/${id}`,
  Expense: (id) => `/expenses/${id}/edit`,
  Journal: (id) => `/journals/${id}`,
  "Vendor Credit": (id) => `/vendor-credits/${id}`,
  "Vendor Credit Refund": (id) => `/vendor-credits/${id}`,
  "Opening Stock": (id) => `/items/${id}`,
  "Inventory Adjustment": (id) => `/inventory-adjustments/${id}`,
  "Fixed Asset": (id) => `/fixed-assets/${id}`,
  Depreciation: (id) => `/fixed-assets/${id}`,
  "Asset Disposal": (id) => `/fixed-assets/${id}`,
  "Exchange Adjustment": () => "/currencies",
  "Exchange Adjustment Reversal": () => "/currencies",
};
export const docLink = (type, id) => (DOC_LINK[type] ? DOC_LINK[type](id) : "#");

export function AccountDetail() {
  const { code } = useParams();
  const [params, setParams] = useSearchParams();
  // Accounts Receivable / Payable: party-wise (default), one party's transactions (?party=), or all (?by=txn).
  const party = params.get("party") || "";
  const [showZero, setShowZero] = useState(false); // as Tally: parties with a nil closing balance hidden
  const by = params.get("by") || "";
  const go = (next) => {
    const p = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) v ? p.set(k, v) : p.delete(k);
    setParams(p);
  };
  const navigate = useNavigate();
  const [range, setRange] = useState(() =>
    params.get("from") ? { key: "custom", from: params.get("from"), to: params.get("to") } : { key: "this_fy", ...periodRange("this_fy") }
  );
  const [data, setData] = useState(null);
  const [modal, setModal] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [view, setView] = useState("tally"); // tally: as Tally / the reports show it; live: with stock movements

  const load = () => api.get(`/accounts/${encodeURIComponent(code)}/transactions`, { params: { from: range.from, to: range.to, view, party: party || undefined, by: by || undefined } }).then((r) => setData(r.data));
  useEffect(() => {
    setData(null);
    load();
  }, [code, range.from, range.to, view, party, by]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!data) return <Spinner />;
  const a = data.account;

  return (
    <>
      <PageHeader title={a.name} subtitle={`${a.group}${a.system ? " · Built-in account" : ""}`} back="/chart-of-accounts">
        {a.code !== "inventory" && (
          <div className="seg" title="Tally view: as Tally and the reports show it. Live: also the moves into stock and the cost of goods sold.">
            <button className={view === "tally" ? "on" : ""} onClick={() => setView("tally")}>
              Tally view
            </button>
            <button className={view === "live" ? "on" : ""} onClick={() => setView("live")}>
              Live
            </button>
          </div>
        )}
        {(a.code === "ar" || a.code === "ap") && (
          <div className="seg" title="Party-wise: one line per customer / vendor, like Tally's Sundry Debtors / Creditors">
            <button className={data.by === "party" ? "on" : ""} onClick={() => go({ party: "", by: "" })}>
              Party-wise
            </button>
            <button className={data.by === "txn" && !data.party ? "on" : ""} onClick={() => go({ party: "", by: "txn" })}>
              All transactions
            </button>
          </div>
        )}
        <PeriodPicker value={range} onChange={setRange} />
        {!a.system && (
          <>
            <button className="btn" onClick={() => setModal(true)}>
              <Icon name="edit" size={16} /> Edit
            </button>
            <button className="icon-btn" title="Delete" onClick={() => setConfirm(true)}>
              <Icon name="trash" />
            </button>
          </>
        )}
      </PageHeader>
      {data.party && (
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10 }}>
          <button className="btn btn-sm" onClick={() => go({ party: "", by: "" })}>
            ← All {a.code === "ar" ? "customers" : "vendors"}
          </button>
          <strong>{data.partyName}</strong>
          {data.party !== "other" && (
            <Link className="small" to={`/${a.code === "ar" ? "customers" : "vendors"}/${data.party}`}>
              Open {a.code === "ar" ? "customer" : "vendor"}
            </Link>
          )}
        </div>
      )}
      {data.by === "party" ? (
        <div className="card flush">
          <table className="table table-click">
            <thead>
              <tr>
                <th>{a.code === "ar" ? "Customer" : "Vendor"}</th>
                <th className="num">Opening</th>
                <th className="num">Debit</th>
                <th className="num">Credit</th>
                <th className="num">Closing</th>
              </tr>
            </thead>
            <tbody>
              {data.parties.filter((p) => showZero || p.closing).map((p) => (
                <tr key={p.id} onClick={() => go({ party: p.id, by: "" })}>
                  <td className={p.id === "other" ? "muted" : "link"}>{p.name}</td>
                  <td className="num">{p.opening ? money(p.opening) : ""}</td>
                  <td className="num">{p.debit ? money(p.debit) : ""}</td>
                  <td className="num">{p.credit ? money(p.credit) : ""}</td>
                  <td className="num">{money(p.closing)}</td>
                </tr>
              ))}
              {!data.parties.length && (
                <tr>
                  <td colSpan={5} className="muted center">
                    No balances in this period
                  </td>
                </tr>
              )}
              <tr className="row-total">
                <td>
                  {data.parties.filter((p) => showZero || p.closing).length} {a.code === "ar" ? "customers" : "vendors"}
                  {data.parties.some((p) => !p.closing) && (
                    <button type="button" className="link-btn small" style={{ marginLeft: 10, fontWeight: 400 }} onClick={() => setShowZero(!showZero)}>
                      {showZero ? "Hide nil balances" : `Show ${data.parties.filter((p) => !p.closing).length} with nil balance`}
                    </button>
                  )}
                </td>
                <td className="num">{money(data.opening)}</td>
                <td className="num">{money(data.totals.debit)}</td>
                <td className="num">{money(data.totals.credit)}</td>
                <td className="num">{money(data.closing)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      ) : (
      <div className="card flush">
        <table className="table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Transaction</th>
              <th>Number</th>
              <th>Customer / Vendor</th>
              <th className="num">Debit</th>
              <th className="num">Credit</th>
              <th className="num">Balance</th>
            </tr>
          </thead>
          <tbody>
            <tr className="row-muted">
              <td colSpan={6}>Opening Balance</td>
              <td className="num">{money(data.opening)}</td>
            </tr>
            {data.rows.map((r, i) => (
              <tr key={i}>
                <td>{date(r.date)}</td>
                <td>{r.type}</td>
                <td>
                  <Link to={docLink(r.type, r.id)}>{r.number}</Link>
                </td>
                <td>{r.party}</td>
                <td className="num">{r.debit ? money(r.debit) : ""}</td>
                <td className="num">{r.credit ? money(r.credit) : ""}</td>
                <td className="num">{money(r.balance, r.currency)}</td>
              </tr>
            ))}
            {!data.rows.length && (
              <tr>
                <td colSpan={7} className="muted center">
                  No transactions in this period
                </td>
              </tr>
            )}
            <tr className="row-total">
              <td colSpan={6}>Closing Balance</td>
              <td className="num">{money(data.closing)}</td>
            </tr>
          </tbody>
        </table>
      </div>
      )}
      <AccountModal open={modal} account={a} onClose={() => setModal(false)} onSaved={() => (setModal(false), load())} />
      <Confirm
        open={confirm}
        title="Delete account?"
        text="Accounts with transactions can't be deleted; mark them inactive instead."
        onConfirm={async () => {
          try {
            await api.delete(`/accounts/${code}`);
            toast("Account deleted");
            navigate("/chart-of-accounts");
          } catch (e) {
            setConfirm(false);
            toast(errMsg(e), "error");
          }
        }}
        onCancel={() => setConfirm(false)}
      />
    </>
  );
}
