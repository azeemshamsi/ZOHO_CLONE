import Attachments from "../components/Attachments";
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import api, { errMsg } from "../lib/api";
import { useAuth } from "../lib/auth";
import { PAYMENT_MODES, modeName } from "../lib/constants";
import { money, amount, date, isoDate, round2, inWords } from "../lib/format";
import { PageHeader, Spinner, Empty, Field, SearchBox, useDebounced, toast, Confirm, Status } from "../components/ui";
import Icon from "../components/Icon";
import { DocEmail } from "../components/EmailDoc";
import BankAccountSelect from "../components/BankAccountSelect";


export function VendorPaymentList() {
  const [rows, setRows] = useState(null);
  const [q, setQ] = useState("");
  const dq = useDebounced(q);
  const navigate = useNavigate();

  useEffect(() => {
    api.get("/vendor-payments", { params: { q: dq } }).then((r) => setRows(r.data));
  }, [dq]);

  return (
    <>
      <PageHeader title="Payments Made">
        <SearchBox value={q} onChange={setQ} placeholder="Search payments made" />
        <Link to="/payments-made/new" className="btn btn-primary">
          <Icon name="plus" size={16} /> New
        </Link>
      </PageHeader>
      {!rows ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <Empty
          icon="bank"
          title={q ? "No payments found" : "No payments made yet"}
          text="Record money you pay vendors and apply it to their bills."
          action={
            <Link to="/payments-made/new" className="btn btn-primary">
              Record Payment
            </Link>
          }
        />
      ) : (
        <div className="card flush">
          <table className="table table-click">
            <thead>
              <tr>
                <th>Date</th>
                <th>Payment#</th>
                <th>Reference#</th>
                <th>Vendor Name</th>
                <th>Bill#</th>
                <th>Mode</th>
                <th className="num">Amount</th>
                <th className="num">Unused Amount</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p._id} onClick={() => navigate(`/payments-made/${p._id}`)}>
                  <td>{date(p.date)}</td>
                  <td className="link strong">{p.paymentNumber}</td>
                  <td>{p.reference}</td>
                  <td>{p.vendorName}</td>
                  <td>{p.allocations.map((a) => a.billNumber).join(", ")}</td>
                  <td>{modeName(p.mode)}</td>
                  <td className="num">{money(p.amount, p.currency)}</td>
                  <td className="num">{money(p.unusedAmount, p.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

export function VendorPaymentForm() {
  const [payCurrencies, setPayCurrencies] = useState([]);
  useEffect(() => {
    api.get("/currencies").then((r) => setPayCurrencies(r.data)).catch(() => {});
  }, []);
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [vendors, setVendors] = useState([]);
  const [bills, setBills] = useState([]);
  const [form, setForm] = useState({
    vendor: params.get("vendor") || "",
    date: isoDate(),
    amount: "",
    mode: "bank_transfer",
    bankAccount: "",
    reference: "",
    notes: "",
  });
  const [alloc, setAlloc] = useState({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get("/vendors").then((r) => setVendors(r.data));
  }, []);

  useEffect(() => {
    if (!form.vendor) return setBills([]);
    api.get("/bills", { params: { vendor: form.vendor, open: "1" } }).then((r) => {
      setBills(r.data);
      const pre = params.get("bill");
      if (pre) {
        const inv = r.data.find((i) => i._id === pre);
        if (inv) {
          setAlloc({ [pre]: inv.balance });
          setForm((f) => ({ ...f, amount: f.amount || inv.balance }));
        }
      } else setAlloc({});
    });
  }, [form.vendor, params]);

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const applied = round2(Object.values(alloc).reduce((s, v) => s + (Number(v) || 0), 0));
  const received = Number(form.amount) || 0;
  const excess = round2(received - applied);

  // Spread the amount received over bills, oldest first (like auto-apply).
  const autoApply = (amt) => {
    let left = Number(amt) || 0;
    const next = {};
    [...bills]
      .sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate))
      .forEach((i) => {
        const x = round2(Math.min(left, i.balance));
        if (x > 0) next[i._id] = x;
        left = round2(left - x);
      });
    setAlloc(next);
  };

  const payParty = vendors.find((x) => x._id === form.vendor);
  const payCur = payParty?.currency || "INR";
  const payRateDefault = payCurrencies.find((c) => c.code === payCur)?.rate;

  const submit = async (e) => {
    e.preventDefault();
    if (excess < 0) return setError("You've applied more than the amount paid.");
    setBusy(true);
    setError("");
    try {
      const { data } = await api.post("/vendor-payments", {
        ...form,
        amount: received,
        exchangeRate: payCur !== "INR" ? Number(form.exchangeRate) || undefined : undefined,
        allocations: Object.entries(alloc)
          .filter(([, v]) => Number(v) > 0)
          .map(([bill, v]) => ({ bill, amount: Number(v) })),
      });
      toast("Payment recorded");
      navigate(`/payments-made/${data._id}`);
    } catch (err) {
      setError(errMsg(err));
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader title="Record Payment" back="/payments-made" />
      <form className="card form" onSubmit={submit}>
        <div className="form-grid">
          <Field label="Vendor Name" required>
            <select required value={form.vendor} onChange={set("vendor")}>
              <option value="">Select a vendor</option>
              {vendors.map((c) => (
                <option key={c._id} value={c._id}>
                  {c.displayName}
                </option>
              ))}
            </select>
          </Field>
          <div className="row-2">
            <Field label={`Amount Paid (${payCur})`} required>
              <input type="number" step="0.01" min="0.01" required value={form.amount} onChange={set("amount")} onBlur={() => !applied && autoApply(form.amount)} />
            </Field>
            <Field label="Payment Date" required>
              <input type="date" required value={form.date} onChange={set("date")} />
            </Field>
          </div>
          {payCur !== "INR" && (
            <Field label={`Exchange Rate (1 ${payCur} = ₹)`} required hint="The rate on the payment date. The difference from the invoice rate is posted as exchange gain or loss.">
              <input type="number" step="0.0001" min="0" value={form.exchangeRate || ""} placeholder={String(payRateDefault || "")} onChange={set("exchangeRate")} />
            </Field>
          )}
          <div className="row-2">
            <Field label="Payment Mode">
              <select value={form.mode} onChange={set("mode")}>
                {PAYMENT_MODES.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Reference#" hint="UTR, cheque number, etc.">
              <input value={form.reference} onChange={set("reference")} />
            </Field>
          </div>
          <div className="row-2">
            <BankAccountSelect label="Paid From" value={form.bankAccount} mode={form.mode} onChange={(v) => setForm({ ...form, bankAccount: v })} />
          </div>
        </div>

        {form.vendor && (
          <>
            <h4 className="section-title">
              Unpaid Bills
              {bills.length > 0 && (
                <button type="button" className="link-btn" onClick={() => autoApply(form.amount)}>
                  Apply amount automatically
                </button>
              )}
            </h4>
            {bills.length === 0 ? (
              <p className="muted">This vendor has no unpaid bills. The full amount will be kept as an advance paid to them.</p>
            ) : (
              <div className="line-table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Bill#</th>
                      <th>Status</th>
                      <th>Due Date</th>
                      <th className="num">Bill Amount</th>
                      <th className="num">Amount Due</th>
                      <th className="num">Payment</th>
                    </tr>
                  </thead>
                  <tbody>
                    {bills.map((i) => (
                      <tr key={i._id}>
                        <td>{date(i.date)}</td>
                        <td>{i.billNumber}</td>
                        <td>
                          <Status value={i.displayStatus} />
                        </td>
                        <td>{date(i.dueDate)}</td>
                        <td className="num">{amount(i.total)}</td>
                        <td className="num">{amount(i.balance)}</td>
                        <td className="num">
                          <input
                            className="pay-input"
                            type="number"
                            step="0.01"
                            min="0"
                            max={i.balance}
                            value={alloc[i._id] ?? ""}
                            onChange={(e) => setAlloc({ ...alloc, [i._id]: e.target.value })}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="totals-box narrow">
              <div className="tot-row">
                <span>Amount Paid</span>
                <span>{money(received)}</span>
              </div>
              <div className="tot-row">
                <span>Amount used for Bills</span>
                <span>{money(applied)}</span>
              </div>
              <div className={`tot-row tot-total ${excess < 0 ? "text-overdue" : ""}`}>
                <span>Amount in Excess</span>
                <span>{money(excess)}</span>
              </div>
            </div>
          </>
        )}

        <div className="form-grid">
          <Field label="Notes">
            <textarea rows={2} value={form.notes} onChange={set("notes")} />
          </Field>
        </div>

        {error && <div className="alert alert-error">{error}</div>}
        <div className="form-footer">
          <button className="btn btn-primary" disabled={busy}>
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

export function VendorPaymentView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { organization } = useAuth();
  const [p, setP] = useState(null);
  const [confirm, setConfirm] = useState(false);

  useEffect(() => {
    api.get(`/vendor-payments/${id}`).then((r) => setP(r.data));
  }, [id]);

  if (!p || !organization) return <Spinner />;

  const remove = async () => {
    try {
      await api.delete(`/vendor-payments/${id}`);
      toast("Payment deleted");
      navigate("/payments-made");
    } catch (e) {
      setConfirm(false);
      toast(errMsg(e), "error");
    }
  };

  return (
    <>
      <PageHeader title={p.paymentNumber} subtitle={p.vendorName} back="/payments-made">
        <button className="btn" onClick={() => window.print()}>
          <Icon name="print" size={16} /> Print / PDF
        </button>
        <DocEmail kind="vendorPayment" id={id} />
        <button className="icon-btn" title="Delete" onClick={() => setConfirm(true)}>
          <Icon name="trash" />
        </button>
      </PageHeader>
      <div className="doc-wrap">
        <div className="invoice-doc receipt">
          <div className="doc-head">
            <div>
              <h2>{organization.name}</h2>
              {organization.gstin && <div className="doc-small">GSTIN {organization.gstin}</div>}
            </div>
          </div>
          <h1 className="receipt-title">PAYMENT MADE</h1>
          <div className="receipt-grid">
            <dl className="details">
              <dt>Payment Date</dt>
              <dd>{date(p.date)}</dd>
              <dt>Reference Number</dt>
              <dd>{p.reference || "—"}</dd>
              <dt>Payment Mode</dt>
              <dd>{modeName(p.mode)}</dd>
              <dt>Amount Paid In Words</dt>
              <dd>
                <em>{inWords(p.amount)}</em>
              </dd>
            </dl>
            <div className="receipt-amount">
              <span>Amount Paid</span>
              <strong>{money(p.amount, p.currency)}</strong>
            </div>
          </div>
          <div className="doc-label">Paid To</div>
          <p>
            <Link to={`/vendors/${p.vendor}`}>
              <strong>{p.vendorName}</strong>
            </Link>
          </p>
          {p.allocations.length > 0 && (
            <>
              <div className="doc-label">Payment For</div>
              <table className="doc-items">
                <thead>
                  <tr>
                    <th>Bill Number</th>
                    <th className="num">Payment Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {p.allocations.map((a) => (
                    <tr key={a.bill}>
                      <td>
                        <Link to={`/bills/${a.bill}`}>{a.billNumber}</Link>
                      </td>
                      <td className="num">{money(a.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
          {p.unusedAmount > 0 && (
            <p className="muted">
              Excess kept as advance with vendor: <strong>{money(p.unusedAmount, p.currency)}</strong>
            </p>
          )}
          {p.notes && <p>{p.notes}</p>}
        </div>
      </div>
      <Confirm
        open={confirm}
        title="Delete this payment?"
        text="The bills it was applied to will become unpaid again."
        onConfirm={remove}
        onCancel={() => setConfirm(false)}
      />
      <Attachments docType="vendorPayment" docId={p._id} />
    </>
  );
}
