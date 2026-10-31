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
          ? { name: account.name, group: account.group, accountCode: account.accountCode || "", description: account.description || "", active: account.active !== false }
          : { name: "", group: "Expense", accountCode: "", description: "", active: true }
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
};
export const docLink = (type, id) => (DOC_LINK[type] ? DOC_LINK[type](id) : "#");

export function AccountDetail() {
  const { code } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [range, setRange] = useState(() =>
    params.get("from") ? { key: "custom", from: params.get("from"), to: params.get("to") } : { key: "this_fy", ...periodRange("this_fy") }
  );
  const [data, setData] = useState(null);
  const [modal, setModal] = useState(false);
  const [confirm, setConfirm] = useState(false);

  const load = () => api.get(`/accounts/${encodeURIComponent(code)}/transactions`, { params: { from: range.from, to: range.to } }).then((r) => setData(r.data));
  useEffect(() => {
    setData(null);
    load();
  }, [code, range.from, range.to]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!data) return <Spinner />;
  const a = data.account;

  return (
    <>
      <PageHeader title={a.name} subtitle={`${a.group}${a.system ? " · Built-in account" : ""}`} back="/chart-of-accounts">
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
                <td className="num">{money(r.balance)}</td>
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
