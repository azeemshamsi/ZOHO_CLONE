import { useEffect, useState } from "react";
import api, { errMsg } from "../lib/api";
import { money, date } from "../lib/format";
import { PageHeader, Spinner, Empty, Field, toast, Modal, Confirm } from "../components/ui";
import Icon from "../components/Icon";

const FIELDS = [
  ["description", "Description"],
  ["reference", "Reference Number"],
  ["amount", "Amount"],
];
const TEXT_OPS = [
  ["contains", "contains"],
  ["not_contains", "doesn't contain"],
  ["equals", "is"],
  ["starts_with", "starts with"],
  ["ends_with", "ends with"],
];
const AMOUNT_OPS = [
  ["equals", "is"],
  ["greater_than", "is greater than"],
  ["less_than", "is less than"],
];
const opLabel = (field, op) => ((field === "amount" ? AMOUNT_OPS : TEXT_OPS).find((o) => o[0] === op) || [op, op])[1];
const fieldLabel = (f) => (FIELDS.find((x) => x[0] === f) || [f, f])[1];

const blankRule = () => ({
  name: "",
  applyTo: "withdrawals",
  accounts: [],
  match: "any",
  conditions: [{ field: "description", op: "contains", value: "" }],
  account: "",
  taxRate: 0,
  notes: "",
  active: true,
});

function AccountPicker({ accounts, value, onChange, exclude = [] }) {
  const choices = accounts.filter((a) => !["ar", "ap", ...exclude].includes(a.code) && a.active !== false);
  const groups = [...new Set(choices.map((a) => a.group))];
  return (
    <select required value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">Select an account</option>
      {groups.map((g) => (
        <optgroup key={g} label={g}>
          {choices
            .filter((a) => a.group === g)
            .map((a) => (
              <option key={a.code} value={a.code}>
                {a.name}
              </option>
            ))}
        </optgroup>
      ))}
    </select>
  );
}

function RuleModal({ open, rule, accounts, banks, onClose, onSaved }) {
  const [f, setF] = useState(blankRule());
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(null);
  useEffect(() => {
    if (open) {
      setF(rule ? { ...blankRule(), ...rule, conditions: rule.conditions.map((c) => ({ ...c })) } : blankRule());
      setPreview(null);
    }
  }, [open, rule]);
  const target = accounts.find((a) => a.code === f.account);
  const setCond = (i, patch) => setF({ ...f, conditions: f.conditions.map((c, j) => (j === i ? { ...c, ...patch } : c)) });
  const body = () => ({
    name: f.name,
    applyTo: f.applyTo,
    accounts: f.accounts,
    match: f.match,
    conditions: f.conditions.filter((c) => String(c.value).trim()),
    account: f.account,
    taxRate: Number(f.taxRate) || 0,
    notes: f.notes,
    active: f.active,
  });

  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      if (rule) await api.put(`/bank-rules/${rule._id}`, body());
      else await api.post("/bank-rules", body());
      toast(rule ? "Rule updated" : "Rule created");
      onSaved();
    } catch (err) {
      toast(errMsg(err), "error");
    } finally {
      setBusy(false);
    }
  };
  const test = async () => {
    try {
      const { data } = await api.post("/bank-rules/preview", body());
      setPreview(data);
    } catch (err) {
      toast(errMsg(err), "error");
    }
  };

  return (
    <Modal open={open} onClose={onClose} wide title={rule ? "Edit Rule" : "New Transaction Rule"}>
      <form className="stack" onSubmit={save}>
        <div className="row-2">
          <Field label="Rule Name" required>
            <input required autoFocus value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. Facebook ads" />
          </Field>
          <Field label="Apply this rule to">
            <div className="radio-row">
              {[
                ["withdrawals", "Withdrawals (money out)"],
                ["deposits", "Deposits (money in)"],
              ].map(([v, l]) => (
                <label key={v} className="radio">
                  <input type="radio" checked={f.applyTo === v} onChange={() => setF({ ...f, applyTo: v, taxRate: v === "deposits" ? 0 : f.taxRate })} /> {l}
                </label>
              ))}
            </div>
          </Field>
        </div>
        <Field label="Bank accounts" hint="Leave all unticked to use the rule on every bank and cash account">
          <div className="chip-checks">
            {banks.map((b) => (
              <label key={b.code} className={`chip-check ${f.accounts.includes(b.code) ? "on" : ""}`}>
                <input
                  type="checkbox"
                  checked={f.accounts.includes(b.code)}
                  onChange={(e) => setF({ ...f, accounts: e.target.checked ? [...f.accounts, b.code] : f.accounts.filter((x) => x !== b.code) })}
                />
                {b.name}
              </label>
            ))}
          </div>
        </Field>

        <h4 className="section-title" style={{ marginTop: 6 }}>
          <span>
            Criteria — when{" "}
            <select className="inline-select" value={f.match} onChange={(e) => setF({ ...f, match: e.target.value })}>
              <option value="any">any</option>
              <option value="all">all</option>
            </select>{" "}
            of these are true
          </span>
        </h4>
        <div className="stack" style={{ gap: 8 }}>
          {f.conditions.map((c, i) => (
            <div key={i} className="cond-row">
              <select value={c.field} onChange={(e) => setCond(i, { field: e.target.value, op: e.target.value === "amount" ? "equals" : "contains" })}>
                {FIELDS.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
              <select value={c.op} onChange={(e) => setCond(i, { op: e.target.value })}>
                {(c.field === "amount" ? AMOUNT_OPS : TEXT_OPS).map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
              <input
                type={c.field === "amount" ? "number" : "text"}
                step="0.01"
                required={i === 0}
                value={c.value}
                placeholder={c.field === "amount" ? "0.00" : "e.g. facebook"}
                onChange={(e) => setCond(i, { value: e.target.value })}
              />
              {f.conditions.length > 1 && (
                <button type="button" className="icon-btn" onClick={() => setF({ ...f, conditions: f.conditions.filter((_, j) => j !== i) })}>
                  <Icon name="x" size={16} />
                </button>
              )}
            </div>
          ))}
          <button type="button" className="link-btn" onClick={() => setF({ ...f, conditions: [...f.conditions, { field: "description", op: "contains", value: "" }] })}>
            <Icon name="plus" size={14} /> Add criterion
          </button>
        </div>

        <h4 className="section-title" style={{ marginTop: 6 }}>
          Then record it as
        </h4>
        <div className="row-3">
          <Field label="Account" required>
            <AccountPicker accounts={accounts} value={f.account} onChange={(v) => setF({ ...f, account: v })} exclude={f.accounts} />
          </Field>
          {f.applyTo === "withdrawals" && target?.type === "expense" && (
            <Field label="GST included" hint="Splits out input tax credit">
              <select value={f.taxRate} onChange={(e) => setF({ ...f, taxRate: Number(e.target.value) })}>
                {[0, 5, 12, 18, 28].map((r) => (
                  <option key={r} value={r}>
                    {r ? `${r}%` : "None"}
                  </option>
                ))}
              </select>
            </Field>
          )}
          <Field label="Notes" hint="Optional; the bank description is used if blank">
            <input value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
          </Field>
        </div>
        <p className="muted small">
          {target
            ? f.applyTo === "withdrawals" && target.type === "expense"
              ? `Each matching line becomes an expense in "${target.name}".`
              : `Each matching line becomes a journal between the bank and "${target.name}".`
            : "Pick where these lines should be recorded."}{" "}
          Lines that already have the same amount recorded in MGI on the same day are left for you to match instead.
        </p>
        {rule && (
          <label className="check">
            <input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Active
          </label>
        )}
        {preview && (
          <div className="customer-chip" style={{ display: "block" }}>
            <strong>{preview.count}</strong> unmatched line{preview.count === 1 ? "" : "s"} would be caught by this rule
            {preview.sample.length > 0 && (
              <ul className="ignored-list">
                {preview.sample.map((l) => (
                  <li key={l._id}>
                    {date(l.date)} · {l.description} · {money(l.deposit || l.withdrawal)}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={test} disabled={!f.account || !f.conditions.some((c) => String(c.value).trim())}>
            Test Rule
          </button>
          <span style={{ flex: 1 }} />
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

export function BankRules() {
  const [rules, setRules] = useState(null);
  const [accounts, setAccounts] = useState([]);
  const [modal, setModal] = useState(null); // null | "new" | rule
  const [confirm, setConfirm] = useState(null);
  const load = () => api.get("/bank-rules").then((r) => setRules(r.data));
  useEffect(() => {
    load();
    api.get("/accounts").then((r) => setAccounts(r.data));
  }, []);
  const banks = accounts.filter((a) => ["Cash", "Bank"].includes(a.group));

  const move = async (i, dir) => {
    const next = [...rules];
    const j = i + dir;
    [next[i], next[j]] = [next[j], next[i]];
    setRules(next);
    await api.post("/bank-rules/reorder", { ids: next.map((r) => r._id) });
  };
  const toggle = async (r) => {
    const { _id, accountName, accountNames, priority, organization, createdAt, updatedAt, __v, ...rest } = r;
    await api.put(`/bank-rules/${_id}`, { ...rest, active: !r.active });
    load();
  };
  const recordAs = (r) => {
    const a = accounts.find((x) => x.code === r.account);
    if (r.applyTo === "withdrawals" && a?.type === "expense") return "Expense";
    return r.applyTo === "deposits" ? "Deposit (journal)" : "Withdrawal (journal)";
  };

  if (!rules) return <Spinner />;
  return (
    <>
      <PageHeader title="Transaction Rules" subtitle="Rules at the top have the highest priority. They run automatically on every statement import." back="/banking">
        <button className="btn btn-primary" onClick={() => setModal("new")}>
          <Icon name="plus" size={16} /> New Rule
        </button>
      </PageHeader>
      {!rules.length ? (
        <Empty
          icon="bank"
          title="No transaction rules yet"
          text="Teach MGI how to record repeat transactions — bank charges, Facebook/Google ads, rent, interest — and they'll be categorised automatically when you import a statement."
          action={
            <button className="btn btn-primary" onClick={() => setModal("new")}>
              New Rule
            </button>
          }
        />
      ) : (
        <div className="card flush">
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: 70 }}>Order</th>
                <th>Rule Name</th>
                <th>Record As</th>
                <th>Details</th>
                <th>Associated Accounts</th>
                <th>Apply To</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rules.map((r, i) => (
                <tr key={r._id} className={r.active ? "" : "row-muted"}>
                  <td className="nowrap">
                    <button className="icon-btn order-btn" disabled={i === 0} onClick={() => move(i, -1)} title="Move up">
                      ↑
                    </button>
                    <button className="icon-btn order-btn" disabled={i === rules.length - 1} onClick={() => move(i, 1)} title="Move down">
                      ↓
                    </button>
                  </td>
                  <td>
                    <button className="link-btn strong" onClick={() => setModal(r)}>
                      {r.name}
                    </button>
                    {!r.active && <span className="tag">Inactive</span>}
                  </td>
                  <td>
                    {recordAs(r)}
                    <div className="muted small">→ {r.accountName}{r.taxRate ? ` · GST ${r.taxRate}%` : ""}</div>
                  </td>
                  <td className="small">
                    {r.conditions.map((c, k) => (
                      <div key={k}>
                        {fieldLabel(c.field)} {opLabel(c.field, c.op)} <strong>{c.field === "amount" ? money(c.value) : c.value}</strong>
                        {k < r.conditions.length - 1 && <span className="muted"> ({r.match === "all" ? "and" : "or"})</span>}
                      </div>
                    ))}
                  </td>
                  <td>{r.accountNames.length ? r.accountNames.join(", ") : <span className="muted">All accounts</span>}</td>
                  <td>
                    <span className={`pill ${r.applyTo === "withdrawals" ? "pill-red" : "pill-green"}`}>{r.applyTo === "withdrawals" ? "Withdrawals" : "Deposits"}</span>
                  </td>
                  <td className="nowrap">
                    <button className="link-btn" onClick={() => toggle(r)}>
                      {r.active ? "Deactivate" : "Activate"}
                    </button>{" "}
                    <button className="icon-btn" title="Delete" onClick={() => setConfirm(r)}>
                      <Icon name="trash" size={16} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <RuleModal
        open={!!modal}
        rule={modal && modal !== "new" ? modal : null}
        accounts={accounts}
        banks={banks}
        onClose={() => setModal(null)}
        onSaved={() => (setModal(null), load())}
      />
      <Confirm
        open={!!confirm}
        title="Delete this rule?"
        text="Lines it already categorised stay as they are."
        onConfirm={async () => {
          await api.delete(`/bank-rules/${confirm._id}`);
          setConfirm(null);
          toast("Rule deleted");
          load();
        }}
        onCancel={() => setConfirm(null)}
      />
    </>
  );
}

export { AccountPicker };
