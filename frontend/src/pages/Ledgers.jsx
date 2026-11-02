import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
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

export function LedgerList({ kind }) {
  const k = LEDGER_KINDS[kind];
  const navigate = useNavigate();
  const [accounts, setAccounts] = useState(null);
  const [modal, setModal] = useState(false);
  const [f, setF] = useState({ name: "", group: k.groups[0] });
  const [existing, setExisting] = useState("");
  const [busy, setBusy] = useState(false);
  const load = () => api.get("/accounts").then((r) => setAccounts(r.data));
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
        <button className="btn btn-primary" onClick={() => setModal(true)}>
          <Icon name="plus" size={16} /> New {k.one}
        </button>
      </PageHeader>
      {ledgers.length === 0 ? (
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
