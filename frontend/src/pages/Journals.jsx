import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import api, { errMsg } from "../lib/api";
import { money, amount, date, isoDate, round2 } from "../lib/format";
import { PageHeader, Spinner, Empty, Field, toast, Confirm } from "../components/ui";
import Icon from "../components/Icon";
import { useLocations } from "../lib/locations";

export function JournalList() {
  const [rows, setRows] = useState(null);
  const navigate = useNavigate();
  useEffect(() => {
    api.get("/journals").then((r) => setRows(r.data));
  }, []);
  return (
    <>
      <PageHeader title="Manual Journals">
        <Link to="/journals/new" className="btn btn-primary">
          <Icon name="plus" size={16} /> New Journal
        </Link>
      </PageHeader>
      {!rows ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <Empty
          icon="book"
          title="No manual journals yet"
          text="Use journals for entries that aren't invoices, bills or expenses: capital introduced, opening balances, depreciation, drawings, corrections."
          action={
            <Link to="/journals/new" className="btn btn-primary">
              New Journal
            </Link>
          }
        />
      ) : (
        <div className="card flush">
          <table className="table table-click">
            <thead>
              <tr>
                <th>Date</th>
                <th>Journal#</th>
                <th>Reference#</th>
                <th>Notes</th>
                <th className="num">Amount</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((j) => (
                <tr key={j._id} onClick={() => navigate(`/journals/${j._id}`)}>
                  <td>{date(j.date)}</td>
                  <td className="link strong">{j.number}</td>
                  <td>{j.reference}</td>
                  <td className="clamp">{j.notes}</td>
                  <td className="num">{money(j.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

const blank = () => ({ account: "", description: "", debit: "", credit: "" });

export function JournalForm() {
  const { branches } = useLocations();
  const { id } = useParams();
  const navigate = useNavigate();
  const [accounts, setAccounts] = useState([]);
  const [form, setForm] = useState(null);
  const [auto, setAuto] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get("/accounts").then((r) => setAccounts(r.data.filter((a) => !["ar", "ap"].includes(a.code) && a.active !== false)));
    if (id) {
      api.get(`/journals/${id}`).then(({ data }) =>
        setForm({
          number: data.number,
          date: isoDate(data.date),
          reference: data.reference,
          branch: data.branch || "",
          notes: data.notes,
          lines: data.lines.map((l) => ({ account: l.account, description: l.description, debit: l.debit || "", credit: l.credit || "" })),
        })
      );
    } else {
      api.get("/journals/next-number").then((r) => setAuto(r.data.number));
      setForm({ number: "", date: isoDate(), reference: "", branch: "", notes: "", lines: [blank(), blank()] });
    }
  }, [id]);

  if (!form) return <Spinner />;
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const setLine = (i, patch) => setForm({ ...form, lines: form.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)) });
  const dr = round2(form.lines.reduce((s, l) => s + (Number(l.debit) || 0), 0));
  const cr = round2(form.lines.reduce((s, l) => s + (Number(l.credit) || 0), 0));
  const diff = round2(dr - cr);
  const groups = [...new Set(accounts.map((a) => a.group))];

  const submit = async (e) => {
    e.preventDefault();
    if (diff !== 0) return setError("Debits and credits must be equal.");
    setBusy(true);
    setError("");
    try {
      const body = {
        ...form,
        branch: form.branch || null,
        lines: form.lines
          .filter((l) => l.account && (Number(l.debit) || Number(l.credit)))
          .map((l) => ({ ...l, debit: Number(l.debit) || 0, credit: Number(l.credit) || 0 })),
      };
      const { data } = id ? await api.put(`/journals/${id}`, body) : await api.post("/journals", body);
      toast(id ? "Journal updated" : "Journal created");
      navigate(`/journals/${data._id}`);
    } catch (err) {
      setError(errMsg(err));
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader title={id ? `Edit ${form.number}` : "New Journal"} back={id ? `/journals/${id}` : "/journals"} />
      <form className="card form" onSubmit={submit}>
        <div className="form-grid">
          <div className="row-3">
            <Field label="Date" required>
              <input type="date" required value={form.date} onChange={set("date")} />
            </Field>
            <Field label="Journal#">
              <input value={form.number} placeholder={auto} onChange={set("number")} />
            </Field>
            <Field label="Reference#">
              <input value={form.reference} onChange={set("reference")} />
            </Field>
          </div>
          {branches.some((b) => b.active) && (
            <Field label="Branch">
              <select value={form.branch || ""} onChange={set("branch")}>
                <option value="">Head Office</option>
                {branches.map((b) => (
                  <option key={b._id} value={b._id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </Field>
          )}
          <Field label="Notes" required>
            <textarea rows={2} required value={form.notes} onChange={set("notes")} placeholder="e.g. Capital introduced by owner" />
          </Field>
        </div>
        <h4 className="section-title">Entries</h4>
        <div className="line-table-wrap">
          <table className="line-table journal-table">
            <thead>
              <tr>
                <th style={{ width: "34%" }}>Account</th>
                <th>Description</th>
                <th className="num">Debits</th>
                <th className="num">Credits</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {form.lines.map((l, i) => (
                <tr key={i}>
                  <td>
                    <select value={l.account} onChange={(e) => setLine(i, { account: e.target.value })} required={i < 2}>
                      <option value="">Select an account</option>
                      {groups.map((g) => (
                        <optgroup key={g} label={g}>
                          {accounts
                            .filter((a) => a.group === g)
                            .map((a) => (
                              <option key={a.code} value={a.code}>
                                {a.name}
                              </option>
                            ))}
                        </optgroup>
                      ))}
                    </select>
                  </td>
                  <td>
                    <input value={l.description} onChange={(e) => setLine(i, { description: e.target.value })} />
                  </td>
                  <td>
                    <input type="number" min="0" step="0.01" className="right" value={l.debit} onChange={(e) => setLine(i, { debit: e.target.value, credit: e.target.value ? "" : l.credit })} />
                  </td>
                  <td>
                    <input type="number" min="0" step="0.01" className="right" value={l.credit} onChange={(e) => setLine(i, { credit: e.target.value, debit: e.target.value ? "" : l.debit })} />
                  </td>
                  <td>
                    {form.lines.length > 2 && (
                      <button type="button" className="icon-btn" onClick={() => setForm({ ...form, lines: form.lines.filter((_, j) => j !== i) })}>
                        <Icon name="x" size={16} />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              <tr className="row-total">
                <td colSpan={2}>Total</td>
                <td className="num">{amount(dr)}</td>
                <td className="num">{amount(cr)}</td>
                <td />
              </tr>
              {diff !== 0 && (
                <tr>
                  <td colSpan={2} className="text-overdue">
                    Difference
                  </td>
                  <td colSpan={2} className="num text-overdue">
                    {amount(Math.abs(diff))}
                  </td>
                  <td />
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <button type="button" className="link-btn add-row" onClick={() => setForm({ ...form, lines: [...form.lines, blank()] })}>
          <Icon name="plus" size={14} /> Add another line
        </button>
        {error && <div className="alert alert-error" style={{ marginTop: 14 }}>{error}</div>}
        <div className="form-footer">
          <button className="btn btn-primary" disabled={busy || diff !== 0 || dr === 0}>
            Save
          </button>
          <button type="button" className="btn" onClick={() => navigate(-1)}>
            Cancel
          </button>
        </div>
      </form>
    </>
  );
}

export function JournalView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [j, setJ] = useState(null);
  const [confirm, setConfirm] = useState(false);
  useEffect(() => {
    api.get(`/journals/${id}`).then((r) => setJ(r.data));
  }, [id]);
  if (!j) return <Spinner />;
  return (
    <>
      <PageHeader title={j.number} subtitle={date(j.date)} back="/journals">
        <Link to={`/journals/${id}/edit`} className="btn">
          <Icon name="edit" size={16} /> Edit
        </Link>
        <button className="btn" onClick={() => window.print()}>
          <Icon name="print" size={16} /> Print / PDF
        </button>
        <button className="icon-btn" title="Delete" onClick={() => setConfirm(true)}>
          <Icon name="trash" />
        </button>
      </PageHeader>
      <div className="card">
        <dl className="details">
          <dt>Reference#</dt>
          <dd>{j.reference || "—"}</dd>
          <dt>Notes</dt>
          <dd>{j.notes || "—"}</dd>
        </dl>
        <table className="table" style={{ marginTop: 18 }}>
          <thead>
            <tr>
              <th>Account</th>
              <th>Description</th>
              <th className="num">Debits</th>
              <th className="num">Credits</th>
            </tr>
          </thead>
          <tbody>
            {j.lines.map((l, i) => (
              <tr key={i}>
                <td>
                  <Link to={`/chart-of-accounts/${encodeURIComponent(l.account)}`}>{l.accountName}</Link>
                </td>
                <td>{l.description}</td>
                <td className="num">{l.debit ? money(l.debit) : ""}</td>
                <td className="num">{l.credit ? money(l.credit) : ""}</td>
              </tr>
            ))}
            <tr className="row-total">
              <td colSpan={2}>Total</td>
              <td className="num">{money(j.total)}</td>
              <td className="num">{money(j.total)}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <Confirm
        open={confirm}
        title="Delete journal?"
        text="This can't be undone."
        onConfirm={async () => {
          try {
            await api.delete(`/journals/${id}`);
            toast("Journal deleted");
            navigate("/journals");
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
