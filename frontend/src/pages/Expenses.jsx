import Attachments from "../components/Attachments";
import BillFromPdf from "../components/BillFromPdf";
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import api, { errMsg } from "../lib/api";
import { useAuth } from "../lib/auth";
import { STATES, GST_RATES, PAYMENT_MODES, modeName } from "../lib/constants";
import { money, date, isoDate, round2 } from "../lib/format";
import { PageHeader, Spinner, Empty, Field, SearchBox, useDebounced, toast, Confirm } from "../components/ui";
import Icon from "../components/Icon";
import { ScheduleFields } from "../components/Schedule";
import { useLocations } from "../lib/locations";
import BankAccountSelect from "../components/BankAccountSelect";


export function ExpenseList() {
  const [rows, setRows] = useState(null);
  const [cats, setCats] = useState([]);
  const [q, setQ] = useState("");
  const [category, setCategory] = useState("all");
  const [fromPdf, setFromPdf] = useState(false);
  const dq = useDebounced(q);
  const navigate = useNavigate();

  useEffect(() => {
    api.get("/expenses/categories").then((r) => setCats(r.data));
  }, []);
  useEffect(() => {
    api.get("/expenses", { params: { q: dq, category } }).then((r) => setRows(r.data));
  }, [dq, category]);

  const total = rows ? round2(rows.reduce((s, r) => s + r.total, 0)) : 0;

  return (
    <>
      <PageHeader title="Expenses">
        <select className="select-inline" value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="all">All Expenses</option>
          {cats.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
        <SearchBox value={q} onChange={setQ} placeholder="Search expenses" />
        <button className="btn" onClick={() => setFromPdf(true)}>
          <Icon name="upload" size={16} /> From bill PDF
        </button>
        <Link to="/expenses/new" className="btn btn-primary">
          <Icon name="plus" size={16} /> New
        </Link>
      </PageHeader>
      {fromPdf && <BillFromPdf kind="expense" onClose={() => setFromPdf(false)} />}
      {!rows ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <Empty
          icon="cart"
          title={q || category !== "all" ? "No expenses found" : "Record your first expense"}
          text="Rent, courier charges, ads, fuel — anything you spend money on that isn't a vendor bill."
          action={
            <Link to="/expenses/new" className="btn btn-primary">
              Record Expense
            </Link>
          }
        />
      ) : (
        <>
          <div className="summary-strip">
            <span className="muted">{rows.length} expenses</span>
            <span>
              Total: <strong>{money(total)}</strong>
            </span>
          </div>
          <div className="card flush">
            <table className="table table-click">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Expense Account</th>
                  <th>Reference#</th>
                  <th>Vendor Name</th>
                  <th>Paid Through</th>
                  <th className="num">GST</th>
                  <th className="num">Amount</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((e) => (
                  <tr key={e._id} onClick={() => navigate(`/expenses/${e._id}/edit`)}>
                    <td>{date(e.date)}</td>
                    <td className="strong link">{e.category}</td>
                    <td>{e.reference}</td>
                    <td>{e.vendorName}</td>
                    <td>{modeName(e.paidThrough)}</td>
                    <td className="num">{money(e.cgst + e.sgst + e.igst)}</td>
                    <td className="num">{money(e.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}

export function ExpenseForm({ recurring = false }) {
  const { id } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { organization } = useAuth();
  const [cats, setCats] = useState([]);
  const [vendors, setVendors] = useState([]);
  const [form, setForm] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const { branches } = useLocations();

  useEffect(() => {
    api.get("/expenses/categories").then((r) => setCats(r.data));
    api.get("/vendors", { params: { status: "active" } }).then((r) => setVendors(r.data));
  }, []);

  useEffect(() => {
    if (id && recurring) {
      api.get(`/recurring/${id}`).then(({ data: p }) => {
        const t = p.template;
        setForm({
          date: isoDate(),
          category: t.category,
          amount: t.amount,
          taxInclusive: !!t.taxInclusive,
          taxRate: t.taxRate || 0,
          placeOfSupply: t.placeOfSupply || organization?.state || "",
          vendor: t.vendor || "",
          branch: t.branch || "",
          paidThrough: t.paidThrough || "upi",
          bankAccount: t.bankAccount || "",
          reference: t.reference || "",
          notes: t.notes || "",
          sched: { name: p.name, every: p.every, unit: p.unit, startDate: isoDate(p.startDate), endDate: p.endDate ? isoDate(p.endDate) : "", never: !p.endDate },
        });
      });
    } else if (id) {
      api.get(`/expenses/${id}`).then(({ data }) =>
        setForm({
          date: isoDate(data.date),
          category: data.category,
          amount: data.amount,
          taxInclusive: false,
          taxRate: data.taxRate,
          placeOfSupply: data.placeOfSupply,
          vendor: data.vendor || "",
          branch: data.branch || "",
          paidThrough: data.paidThrough,
          bankAccount: data.bankAccount || "",
          reference: data.reference,
          notes: data.notes,
        })
      );
    } else {
      setForm({
        date: isoDate(),
        category: "",
        amount: "",
        taxInclusive: true,
        taxRate: 0,
        placeOfSupply: organization?.state || "",
        vendor: params.get("vendor") || "",
        branch: "",
        paidThrough: "upi",
        bankAccount: "",
        reference: "",
        notes: "",
        sched: recurring ? { name: "", every: 1, unit: "month", startDate: isoDate(), endDate: "", never: true } : undefined,
      });
    }
  }, [id, organization, params, recurring]);

  if (!form) return <Spinner />;
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value });

  const pickVendor = (e) => {
    const v = vendors.find((x) => x._id === e.target.value);
    setForm({ ...form, vendor: e.target.value, placeOfSupply: v?.placeOfSupply || form.placeOfSupply });
  };

  // Live GST preview
  const amt = Number(form.amount) || 0;
  const rate = Number(form.taxRate) || 0;
  const base = form.taxInclusive ? round2(amt / (1 + rate / 100)) : amt;
  const tax = form.taxInclusive ? round2(amt - base) : round2((amt * rate) / 100);
  const inter = form.placeOfSupply && organization?.state && form.placeOfSupply !== organization.state;

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const body = { ...form, amount: Number(form.amount), taxRate: Number(form.taxRate), vendor: form.vendor || null, branch: form.branch || null };
      if (recurring) {
        const sc = form.sched;
        const template = { ...body };
        delete template.sched;
        delete template.date;
        const rbody = { kind: "expense", name: sc.name, every: Number(sc.every), unit: sc.unit, startDate: sc.startDate, endDate: sc.never ? null : sc.endDate, template };
        const { data } = id ? await api.put(`/recurring/${id}`, rbody) : await api.post("/recurring", rbody);
        toast(id ? "Recurring expense updated" : "Recurring expense created");
        navigate(`/recurring-expenses/${data._id}`);
        return;
      }
      delete body.sched;
      if (id) await api.put(`/expenses/${id}`, body);
      else await api.post("/expenses", body);
      toast(id ? "Expense updated" : "Expense recorded");
      navigate("/expenses");
    } catch (err) {
      setError(errMsg(err));
      setBusy(false);
    }
  };

  const remove = async () => {
    try {
      await api.delete(`/expenses/${id}`);
      toast("Expense deleted");
      navigate("/expenses");
    } catch (e) {
      setConfirm(false);
      toast(errMsg(e), "error");
    }
  };

  return (
    <>
      <PageHeader title={recurring ? (id ? "Edit Recurring Expense" : "New Recurring Expense") : id ? "Edit Expense" : "Record Expense"} back={recurring ? "/recurring-expenses" : "/expenses"}>
        {id && !recurring && (
          <button className="icon-btn" title="Delete" onClick={() => setConfirm(true)}>
            <Icon name="trash" />
          </button>
        )}
      </PageHeader>
      <form className="card form" onSubmit={submit}>
        <div className="form-grid">
          {recurring && <ScheduleFields sched={form.sched} onChange={(sched) => setForm({ ...form, sched })} />}
          <div className="row-2">
            {!recurring && (
              <Field label="Date" required>
                <input type="date" required value={form.date} onChange={set("date")} />
              </Field>
            )}
            <Field label="Expense Account" required>
              <select required value={form.category} onChange={set("category")}>
                <option value="">Select an account</option>
                {cats.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </Field>
          </div>
          <div className="row-2">
            <Field label="Amount (₹)" required>
              <input type="number" step="0.01" min="0.01" required value={form.amount} onChange={set("amount")} />
            </Field>
            <Field label="GST Rate">
              <select value={form.taxRate} onChange={set("taxRate")}>
                {GST_RATES.map((r) => (
                  <option key={r} value={r}>
                    {r === 0 ? "No GST / Exempt" : `GST ${r}%`}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          {rate > 0 && (
            <>
              <label className="check">
                <input type="checkbox" checked={form.taxInclusive} onChange={set("taxInclusive")} /> Amount includes GST
              </label>
              <div className="customer-chip">
                <span>
                  Before tax <b>{money(base)}</b>
                </span>
                <span>
                  {inter ? "IGST" : "CGST + SGST"} <b>{money(tax)}</b>
                </span>
                <span>
                  Total <b>{money(base + tax)}</b>
                </span>
              </div>
            </>
          )}
          <div className="row-2">
            <Field label="Paid Through">
              <select value={form.paidThrough} onChange={set("paidThrough")}>
                {PAYMENT_MODES.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            </Field>
            <BankAccountSelect label="Paid From" value={form.bankAccount} mode={form.paidThrough} onChange={(v) => setForm({ ...form, bankAccount: v })} />
          </div>
          <div className="row-2">
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
            <Field label="Vendor" hint="Optional">
              <select value={form.vendor} onChange={pickVendor}>
                <option value="">None</option>
                {vendors.map((v) => (
                  <option key={v._id} value={v._id}>
                    {v.displayName}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <div className="row-2">
            <Field label="Source of Supply">
              <select value={form.placeOfSupply} onChange={set("placeOfSupply")}>
                {STATES.map(([c, n]) => (
                  <option key={c} value={c}>
                    [{c}] {n}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Reference#" hint="Receipt or UTR number">
              <input value={form.reference} onChange={set("reference")} />
            </Field>
          </div>
          <Field label="Notes">
            <textarea rows={2} value={form.notes} onChange={set("notes")} />
          </Field>
        </div>
        {error && <div className="alert alert-error">{error}</div>}
        <div className="form-footer">
          <button className="btn btn-primary" disabled={busy}>
            Save
          </button>
          <button type="button" className="btn" onClick={() => navigate(recurring ? "/recurring-expenses" : "/expenses")}>
            Cancel
          </button>
        </div>
      </form>
      {id && !recurring && <Attachments docType="expense" docId={id} />}
      <Confirm open={confirm} title="Delete expense?" text="This can't be undone." onConfirm={remove} onCancel={() => setConfirm(false)} />
    </>
  );
}
