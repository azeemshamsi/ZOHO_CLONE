import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { PeriodPicker } from "./Reports";
import { docLink } from "./Accounts";
import { periodRange } from "../lib/period";
import { date as fmtDate } from "../lib/format";
import api, { errMsg } from "../lib/api";
import { money } from "../lib/format";
import { PageHeader, Spinner, Empty, Field, toast, Modal } from "../components/ui";
import Icon from "../components/Icon";

// Sales ledgers (Tally "Sales Accounts": "OutState Sales 5%", "Invoice Sale @ 18% Ex Up"…) and purchase
// ledgers. They are accounts marked as such; invoices / bills pick one, and their amounts post to it.
export const LEDGER_KINDS = {
  sales: { title: "Sales Ledgers", one: "sales ledger", groups: ["Income", "Other Income"], doc: "invoices and credit notes", fallback: "Sales" },
  purchase: { title: "Purchase Ledgers", one: "purchase ledger", groups: ["Cost Of Goods Sold", "Expense", "Other Expense"], doc: "bills and vendor credits", fallback: "Cost of Goods Sold" },
};

// Voucher types as Tally names them.
const VTYPE = { invoice: "Sales", creditNote: "Credit Note", bill: "Purchase", vendorCredit: "Debit Note", payment: "Receipt", vendorPayment: "Payment", journal: "Journal", expense: "Payment (Expense)", inventoryAdjustment: "Stock Journal", openingBalance: "Opening Balance" };
const vtype = (t) => VTYPE[t] || String(t || "").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase());

const VIEWS = [
  ["summary", "Summary", "S", "Masters and ledgers with their balances"],
  ["detailed", "Detailed", "D", "Every master opened up to its ledgers (Alt+F5)"],
  ["transactions", "Transactions", "T", "All vouchers of these ledgers for a period"],
];

// Tally's Ctrl+H "Change View".
function ViewMenu({ view, onPick, onClose }) {
  const [i, setI] = useState(Math.max(0, VIEWS.findIndex((v) => v[0] === view)));
  useEffect(() => {
    const k = (e) => {
      const hit = VIEWS.find((v) => v[2].toLowerCase() === e.key.toLowerCase());
      if (hit) (e.preventDefault(), e.stopPropagation(), onPick(hit[0]));
      if (e.key === "ArrowDown") (e.preventDefault(), setI((x) => Math.min(x + 1, VIEWS.length - 1)));
      if (e.key === "ArrowUp") (e.preventDefault(), setI((x) => Math.max(x - 1, 0)));
      if (e.key === "Enter") (e.preventDefault(), e.stopPropagation(), onPick(VIEWS[i][0]));
    };
    window.addEventListener("keydown", k, true);
    return () => window.removeEventListener("keydown", k, true);
  }, [i]);
  return (
    <Modal open title="Change View (Ctrl+H)" onClose={onClose}>
      {VIEWS.map(([k, l, key, d], n) => (
        <div key={k} onMouseDown={() => onPick(k)} onMouseEnter={() => setI(n)} style={{ padding: "9px 12px", borderRadius: 6, cursor: "pointer", background: n === i ? "var(--blue-50, #eef4ff)" : "transparent", display: "flex", gap: 12, alignItems: "baseline" }}>
          <kbd style={{ fontFamily: "monospace", border: "1px solid var(--border, #e5e7eb)", borderRadius: 4, padding: "0 6px" }}>{key}</kbd>
          <strong>{l}</strong>
          <span className="muted small">{d}</span>
          {k === view && <span className="muted small" style={{ marginLeft: "auto" }}>current</span>}
        </div>
      ))}
    </Modal>
  );
}

// All vouchers of a set of ledgers, for a period; filter by master or ledger.
function TransactionsView({ ledgers, groups }) {
  const [range, setRange] = useState(() => ({ key: "this_fy", ...periodRange("this_fy") }));
  const [scope, setScope] = useState("all");
  const [d, setD] = useState(null);
  const codes = scope === "all" ? ledgers.map((a) => a.code) : scope.startsWith("g:") ? groups.find((g) => g._id === scope.slice(2))?.members || [] : [scope];
  useEffect(() => {
    setD(null);
    if (!codes.length) return setD({ rows: [], ledgers: [] });
    api
      .get("/accounts/transactions", { params: { codes: codes.join(","), from: range.from, to: range.to } })
      .then((r) => setD(r.data))
      .catch((e) => toast(errMsg(e), "error"));
  }, [scope, range.from, range.to, ledgers.length]);
  const tot = (k) => (d?.ledgers || []).reduce((t, x) => t + (Number(x[k]) || 0), 0);
  return (
    <div className="card flush">
      <div className="pad-row" style={{ padding: "10px 16px", display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        <select value={scope} onChange={(e) => setScope(e.target.value)} style={{ maxWidth: 320 }}>
          <option value="all">All ledgers</option>
          {groups.map((g) => (
            <option key={g._id} value={`g:${g._id}`}>
              Master: {g.name}
            </option>
          ))}
          {ledgers.map((a) => (
            <option key={a.code} value={a.code}>
              {a.name}
            </option>
          ))}
        </select>
        <PeriodPicker value={range} onChange={setRange} />
        {d && (
          <span className="muted small" style={{ marginLeft: "auto" }}>
            {d.rows.length} vouchers · Opening {money(tot("opening"))} · Dr {money(tot("debit"))} · Cr {money(tot("credit"))} · Closing {money(tot("closing"))}
          </span>
        )}
      </div>
      {!d ? (
        <Spinner />
      ) : (
        <table className="table compact">
          <thead>
            <tr>
              <th>Date</th>
              <th>Voucher</th>
              <th>No.</th>
              <th>Party</th>
              <th>Ledger</th>
              <th className="num">Debit</th>
              <th className="num">Credit</th>
            </tr>
          </thead>
          <tbody>
            {d.rows.map((r, i) => (
              <tr key={i}>
                <td className="nowrap">{fmtDate(r.date)}</td>
                <td>{vtype(r.type)}</td>
                <td>{docLink(r.type, r.id) ? <Link to={docLink(r.type, r.id)}>{r.number}</Link> : r.number}</td>
                <td>{r.party}</td>
                <td className="small">{r.ledger}</td>
                <td className="num">{r.debit ? money(r.debit) : ""}</td>
                <td className="num">{r.credit ? money(r.credit) : ""}</td>
              </tr>
            ))}
            {!d.rows.length && (
              <tr>
                <td colSpan={7} className="muted center">
                  No transactions in this period
                </td>
              </tr>
            )}
            {d.rows.length > 0 && (
              <tr className="row-total">
                <td colSpan={5}>Total</td>
                <td className="num">{money(tot("debit"))}</td>
                <td className="num">{money(tot("credit"))}</td>
              </tr>
            )}
          </tbody>
        </table>
      )}
      {d?.more && <p className="muted small" style={{ padding: "0 16px" }}>Showing the first 20,000 — narrow the period to see the rest.</p>}
    </div>
  );
}

// A master ledger: name + member ledgers (tick to add, untick to remove).
function MasterModal({ group, kind, ledgers, groups, onClose, onSaved }) {
  const [name, setName] = useState(group.name || "");
  const [members, setMembers] = useState(new Set(group.members || []));
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const inOther = (code) => groups.find((g) => g._id !== group._id && g.members.includes(code))?.name;
  const shown = ledgers.filter((a) => !q || a.name.toLowerCase().includes(q.toLowerCase()));
  const save = async () => {
    setBusy(true);
    try {
      const body = { kind, name, members: [...members] };
      if (group._id) await api.put(`/accounts/ledger-groups/${group._id}`, body);
      else await api.post("/accounts/ledger-groups", body);
      toast("Master ledger saved");
      onSaved();
    } catch (e) {
      toast(errMsg(e), "error");
    }
    setBusy(false);
  };
  const remove = async () => {
    if (!window.confirm(`Delete the master ledger "${group.name}"? Its ledgers stay; only the grouping goes.`)) return;
    await api.delete(`/accounts/ledger-groups/${group._id}`);
    toast("Master ledger deleted");
    onSaved();
  };
  return (
    <Modal
      open
      wide
      title={group._id ? `Master ledger: ${group.name}` : "New master ledger"}
      onClose={onClose}
      footer={
        <>
          {group._id && (
            <button className="btn btn-danger" style={{ marginRight: "auto" }} onClick={remove}>
              Delete
            </button>
          )}
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={busy || !name.trim()} onClick={save}>
            Save
          </button>
        </>
      }
    >
      <div className="form-grid">
        <Field label="Name" required>
          <input value={name} autoFocus onChange={(e) => setName(e.target.value)} placeholder="e.g. Invoice Sale" />
        </Field>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
          <div className="label-sm" style={{ margin: 0 }}>
            Ledgers in it ({members.size})
          </div>
          <input style={{ maxWidth: 260 }} placeholder="Search ledgers…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div style={{ maxHeight: 360, overflow: "auto", border: "1px solid var(--border, #e5e7eb)", borderRadius: 6 }}>
          <table className="table compact">
            <tbody>
              {shown.map((a) => (
                <tr key={a.code}>
                  <td style={{ width: 30 }}>
                    <input
                      type="checkbox"
                      checked={members.has(a.code)}
                      onChange={(e) => {
                        const n = new Set(members);
                        e.target.checked ? n.add(a.code) : n.delete(a.code);
                        setMembers(n);
                      }}
                    />
                  </td>
                  <td>
                    {a.name}
                    {!members.has(a.code) && inOther(a.code) && <span className="muted small"> · in {inOther(a.code)} (moves here if ticked)</span>}
                  </td>
                  <td className="num">{money(a.balance)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Modal>
  );
}

export function LedgerList({ kind }) {
  const k = LEDGER_KINDS[kind];
  const navigate = useNavigate();
  const [accounts, setAccounts] = useState(null);
  const [modal, setModal] = useState(false);
  const [f, setF] = useState({ name: "", group: k.groups[0] });
  const [existing, setExisting] = useState("");
  const [busy, setBusy] = useState(false);
  const [groups, setGroups] = useState([]);
  const [master, setMaster] = useState(null);
  const [openGroups, setOpenGroups] = useState(new Set());
  const [view, setView] = useState("summary");
  const [viewMenu, setViewMenu] = useState(false);
  useEffect(() => {
    const v = () => setViewMenu(true);
    const det = () => setView((x) => (x === "detailed" ? "summary" : "detailed"));
    window.addEventListener("tally:view", v);
    window.addEventListener("tally:detail", det);
    return () => (window.removeEventListener("tally:view", v), window.removeEventListener("tally:detail", det));
  }, []);
  const load = () => Promise.all([api.get("/accounts").then((r) => setAccounts(r.data)), api.get("/accounts/ledger-groups", { params: { kind } }).then((r) => setGroups(r.data)).catch(() => setGroups([]))]);
  useEffect(() => {
    setAccounts(null);
    load();
  }, [kind]);

  if (!accounts) return <Spinner />;
  const ledgers = accounts.filter((a) => a.ledgerKind === kind);
  const candidates = accounts.filter((a) => !a.system && !a.ledgerKind && k.groups.includes(a.group) && a.active !== false);

  const create = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      if (existing) {
        const a = accounts.find((x) => x.code === existing);
        await api.put(`/accounts/${a.code}`, { name: a.name, group: a.group, accountCode: a.accountCode || "", description: a.description || "", ledgerKind: kind });
      } else await api.post("/accounts", { ...f, ledgerKind: kind });
      toast(existing ? "Marked as a " + k.one : `${f.name} created`);
      setModal(false);
      setF({ name: "", group: k.groups[0] });
      setExisting("");
      load();
    } catch (err) {
      toast(errMsg(err), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader title={k.title}>
        <div className="seg" data-views title="Ctrl+H change view · Alt+F5 detailed">
          {VIEWS.map(([v, l]) => (
            <button key={v} className={view === v ? "on" : ""} onClick={() => setView(v)}>
              {l}
            </button>
          ))}
        </div>
        <button
          className="btn"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              const { data } = await api.post("/accounts/ledger-kinds/refresh");
              const n = kind === "sales" ? data.sales : data.purchase;
              toast(n ? `${n} ${k.one}${n > 1 ? "s" : ""} found and added` : `No new ${k.one}s found (${data.usedBySales} accounts used by invoices, ${data.accounts} accounts checked)`);
              load();
            } catch (err) {
              toast(errMsg(err), "error");
            }
            setBusy(false);
          }}
        >
          Find ledgers from {kind === "sales" ? "invoices" : "bills"}
        </button>
        <button className="btn" onClick={() => setMaster({})}>
          + Master ledger
        </button>
        <button className="btn btn-primary" onClick={() => setModal(true)}>
          <Icon name="plus" size={16} /> New {k.one}
        </button>
      </PageHeader>
      {viewMenu && (
        <ViewMenu
          view={view}
          onClose={() => setViewMenu(false)}
          onPick={(v) => {
            setView(v);
            setViewMenu(false);
          }}
        />
      )}
      {view === "transactions" && <TransactionsView ledgers={ledgers} groups={groups} />}
      {view !== "transactions" && groups.length > 0 && (
        <div className="card flush" style={{ marginBottom: 14 }}>
          <table className="table">
            <thead>
              <tr>
                <th>Master ledger</th>
                <th>Ledgers</th>
                <th className="num">Balance</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => {
                const members = ledgers.filter((a) => g.members.includes(a.code));
                const open = view === "detailed" || openGroups.has(g._id);
                return [
                  <tr key={g._id} className="table-click" onClick={() => setOpenGroups((s) => (s.has(g._id) ? new Set([...s].filter((x) => x !== g._id)) : new Set([...s, g._id])))}>
                    <td className="strong">
                      {open ? "▾" : "▸"} {g.name}
                    </td>
                    <td>{members.length}</td>
                    <td className="num strong">{money(members.reduce((t, a) => t + (Number(a.balance) || 0), 0))}</td>
                    <td style={{ textAlign: "right" }} onClick={(e) => e.stopPropagation()}>
                      <button className="btn btn-sm" onClick={() => setMaster(g)}>
                        Add / remove ledgers
                      </button>
                    </td>
                  </tr>,
                  ...(open
                    ? members.map((a) => (
                        <tr key={g._id + a.code} className="table-click" onClick={() => navigate(`/chart-of-accounts/${encodeURIComponent(a.code)}`)}>
                          <td style={{ paddingLeft: 36 }} className="link">
                            {a.name}
                          </td>
                          <td className="muted small">{a.group}</td>
                          <td className="num">{money(a.balance)}</td>
                          <td />
                        </tr>
                      ))
                    : []),
                ];
              })}
            </tbody>
          </table>
        </div>
      )}
      {view === "transactions" ? null : ledgers.length === 0 ? (
        <Empty
          icon="book"
          title={`No ${k.one}s yet`}
          text={`Create ledgers like Tally's (e.g. "${kind === "sales" ? "OutState Sales 18%" : "Purchase Local @ 18%"}") and pick one on ${k.doc}. Ledgers under Tally's ${kind === "sales" ? "Sales" : "Purchase"} Accounts are added when you import Tally masters.`}
          action={
            <button className="btn btn-primary" onClick={() => setModal(true)}>
              New {k.one}
            </button>
          }
        />
      ) : (
        <div className="card flush">
          <table className="table table-click">
            <thead>
              <tr>
                <th>Ledger</th>
                <th>Account Type</th>
                {groups.length > 0 && <th>Master ledger</th>}
                <th className="num">Balance</th>
              </tr>
            </thead>
            <tbody>
              {ledgers.map((a) => (
                <tr key={a.code} onClick={() => navigate(`/chart-of-accounts/${encodeURIComponent(a.code)}`)}>
                  <td className="link strong">
                    {a.name}
                    {a.active === false && <span className="muted small"> (inactive)</span>}
                  </td>
                  <td>{a.group}</td>
                  {groups.length > 0 && <td className="muted">{groups.find((g) => g.members.includes(a.code))?.name || "—"}</td>}
                  <td className="num">{money(a.balance)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="muted small" style={{ marginTop: 10 }}>
        Documents without a ledger post to {k.fallback}.{kind === "purchase" ? " Stock items you track still go to Inventory Asset (and to Cost of Goods Sold when sold); the ledger gets the rest of the bill." : ""}
      </p>
      {master && (
        <MasterModal
          group={master}
          kind={kind}
          ledgers={ledgers}
          groups={groups}
          onClose={() => setMaster(null)}
          onSaved={() => {
            setMaster(null);
            load();
          }}
        />
      )}
      <Modal open={modal} onClose={() => setModal(false)} title={`New ${k.one}`}>
        <form className="stack" onSubmit={create}>
          {candidates.length > 0 && (
            <Field label="Use an existing account" hint="Or leave this and create a new one below">
              <select value={existing} onChange={(e) => setExisting(e.target.value)}>
                <option value="">— Create a new ledger —</option>
                {candidates.map((a) => (
                  <option key={a.code} value={a.code}>
                    {a.name} ({a.group})
                  </option>
                ))}
              </select>
            </Field>
          )}
          {!existing && (
            <>
              <Field label="Ledger Name" required>
                <input required autoFocus value={f.name} placeholder={kind === "sales" ? "e.g. OutState Sales 18%" : "e.g. Purchase Local @ 18%"} onChange={(e) => setF({ ...f, name: e.target.value })} />
              </Field>
              <Field label="Account Type" required>
                <select value={f.group} onChange={(e) => setF({ ...f, group: e.target.value })}>
                  {k.groups.map((g) => (
                    <option key={g}>{g}</option>
                  ))}
                </select>
              </Field>
            </>
          )}
          <div className="modal-actions">
            <button type="button" className="btn" onClick={() => setModal(false)}>
              Cancel
            </button>
            <button className="btn btn-primary" disabled={busy}>
              Save
            </button>
          </div>
        </form>
      </Modal>
    </>
  );
}
