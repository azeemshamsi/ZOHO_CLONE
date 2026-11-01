import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import api, { errMsg } from "../lib/api";
import { useAuth } from "../lib/auth";
import { KINDS } from "../lib/docKinds";
import { PAYMENT_MODES, modeName } from "../lib/constants";
import { money, amount, date, isoDate, round2 } from "../lib/format";
import { PageHeader, Spinner, toast, Status, Confirm, Modal, MoreMenu, Field, invoiceStatus } from "../components/ui";
import { DocList, DocForm, DocPaper, MiniTable } from "../components/SalesDoc";
import Icon from "../components/Icon";
import { DocEmail } from "../components/EmailDoc";
import BankAccountSelect from "../components/BankAccountSelect";


const K = KINDS.creditNote;

export function CreditNoteList() {
  return (
    <DocList
      kind={K}
      filters={[
        ["all", "All Credit Notes"],
        ["draft", "Draft"],
        ["open", "Open"],
        ["closed", "Closed"],
        ["void", "Void"],
      ]}
      emptyText="Give customers credit for returns, discounts after sale or billing mistakes, then use it on their invoices or refund it."
      columns={[
        { label: "Date", render: (r) => date(r.date) },
        { label: "Credit Note#", cls: "link strong", render: (r) => r.number },
        { label: "Reference#", render: (r) => r.reference },
        { label: "Customer Name", render: (r) => r.customerName },
        { label: "Invoice#", render: (r) => r.invoiceNumber },
        { label: "Status", render: (r) => <Status value={r.status} /> },
        { label: "Amount", num: true, render: (r) => money(r.total) },
        { label: "Balance", num: true, render: (r) => money(r.balance) },
      ]}
    />
  );
}

export const CreditNoteForm = () => <DocForm kind={K} />;

function ApplyToInvoices({ cn, open, onClose, onDone }) {
  const [invoices, setInvoices] = useState(null);
  const [alloc, setAlloc] = useState({});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    api.get("/invoices", { params: { customer: cn.customer, open: "1" } }).then((r) => {
      const list = r.data.filter((i) => i.status !== "draft" && i.balance > 0);
      setInvoices(list);
      // Pre-fill: the linked invoice first, then oldest due.
      list.sort((a, b) => (String(a._id) === String(cn.invoice) ? -1 : String(b._id) === String(cn.invoice) ? 1 : new Date(a.dueDate) - new Date(b.dueDate)));
      let left = cn.balance;
      const pre = {};
      list.forEach((i) => {
        const x = round2(Math.min(left, i.balance));
        if (x > 0) pre[i._id] = x;
        left = round2(left - x);
      });
      setAlloc(pre);
    });
  }, [open, cn]);
  const applied = round2(Object.values(alloc).reduce((s, v) => s + (Number(v) || 0), 0));
  const save = async () => {
    setBusy(true);
    try {
      await api.post(`/credit-notes/${cn._id}/apply`, {
        allocations: Object.entries(alloc)
          .filter(([, v]) => Number(v) > 0)
          .map(([invoice, v]) => ({ invoice, amount: Number(v) })),
      });
      toast("Credits applied");
      onDone();
    } catch (e) {
      toast(errMsg(e), "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      wide
      title={`Apply credits from ${cn.number}`}
      footer={
        <>
          <span className={`small ${applied > cn.balance ? "text-overdue" : "muted"}`} style={{ marginRight: "auto" }}>
            Available {money(cn.balance)} · Applying {money(applied)}
          </span>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={busy || !applied || applied > cn.balance} onClick={save}>
            Save
          </button>
        </>
      }
    >
      {!invoices ? (
        <Spinner />
      ) : invoices.length === 0 ? (
        <p className="muted">This customer has no unpaid invoices. You can refund the credit instead.</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Invoice#</th>
              <th>Date</th>
              <th>Status</th>
              <th className="num">Invoice Amount</th>
              <th className="num">Balance Due</th>
              <th className="num">Amount to Credit</th>
            </tr>
          </thead>
          <tbody>
            {invoices.map((i) => (
              <tr key={i._id}>
                <td>{i.invoiceNumber}</td>
                <td>{date(i.date)}</td>
                <td>
                  <Status value={invoiceStatus(i.displayStatus)} />
                </td>
                <td className="num">{amount(i.total)}</td>
                <td className="num">{amount(i.balance)}</td>
                <td className="num">
                  <input
                    className="pay-input"
                    type="number"
                    min="0"
                    step="0.01"
                    max={i.balance}
                    value={alloc[i._id] ?? ""}
                    onChange={(e) => setAlloc({ ...alloc, [i._id]: e.target.value })}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Modal>
  );
}

function RefundModal({ cn, open, onClose, onDone }) {
  const [f, setF] = useState({ date: isoDate(), amount: "", mode: "bank_transfer", bankAccount: "", reference: "" });
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) setF((x) => ({ ...x, amount: cn.balance }));
  }, [open, cn]);
  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.post(`/credit-notes/${cn._id}/refund`, { ...f, amount: Number(f.amount) });
      toast("Refund recorded");
      onDone();
    } catch (err) {
      toast(errMsg(err), "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={open} onClose={onClose} title={`Refund from ${cn.number}`}>
      <form className="stack" onSubmit={save}>
        <Field label="Amount (₹)" required hint={`Available: ${money(cn.balance)}`}>
          <input type="number" required min="0.01" step="0.01" max={cn.balance} value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} />
        </Field>
        <div className="row-2">
          <Field label="Refunded On" required>
            <input type="date" required value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} />
          </Field>
          <Field label="Payment Mode">
            <select value={f.mode} onChange={(e) => setF({ ...f, mode: e.target.value })}>
              {PAYMENT_MODES.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <div className="row-2">
          <BankAccountSelect label="Paid From" value={f.bankAccount} mode={f.mode} onChange={(v) => setF({ ...f, bankAccount: v })} />
          <Field label="Reference#">
            <input value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} />
          </Field>
        </div>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={busy}>
            Save Refund
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function CreditNoteView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { organization } = useAuth();
  const [cn, setCn] = useState(null);
  const [modal, setModal] = useState(null);

  const load = () => api.get(`/credit-notes/${id}`).then((r) => setCn(r.data));
  useEffect(() => {
    load();
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!cn || !organization) return <Spinner />;

  const act = async (fn, msg) => {
    try {
      await fn();
      toast(msg);
      setModal(null);
      load();
    } catch (e) {
      setModal(null);
      toast(errMsg(e), "error");
    }
  };
  const usedAmt = round2(cn.applications.reduce((s, a) => s + a.amount, 0) + cn.refunds.reduce((s, r) => s + r.amount, 0));
  const isOpen = cn.status === "open";

  return (
    <>
      <PageHeader title={cn.number} subtitle={cn.customerName} back="/credit-notes">
        {cn.status !== "void" && (
          <Link to={`/credit-notes/${id}/edit`} className="btn">
            <Icon name="edit" size={16} /> Edit
          </Link>
        )}
        <button className="btn" onClick={() => window.print()}>
          <Icon name="print" size={16} /> Print / PDF
        </button>
        <DocEmail kind="creditNote" id={id} onSent={load} />
        {cn.status === "draft" && (
          <button className="btn btn-primary" onClick={() => act(() => api.post(`/credit-notes/${id}/open`), "Credit note opened")}>
            Convert to Open
          </button>
        )}
        {isOpen && (
          <button className="btn btn-primary" onClick={() => setModal("apply")}>
            Apply to Invoices
          </button>
        )}
        <MoreMenu
          items={[
            isOpen && { label: "Refund", onClick: () => setModal("refund") },
            usedAmt === 0 && cn.status !== "void" && { label: "Void", onClick: () => setModal("void") },
            usedAmt === 0 && { label: "Delete", danger: true, onClick: () => setModal("delete") },
          ]}
        />
      </PageHeader>

      {isOpen && (
        <div className="banner banner-amber no-print">
          <span>
            <strong>{money(cn.balance)}</strong> of credit is still available.
          </span>
          <span className="page-actions">
            <button className="btn btn-sm" onClick={() => setModal("refund")}>
              Refund
            </button>
            <button className="btn btn-sm btn-primary" onClick={() => setModal("apply")}>
              Apply to Invoices
            </button>
          </span>
        </div>
      )}

      {cn.applications.length > 0 && (
        <MiniTable
          title="Invoices Credited"
          rows={cn.applications}
          columns={[
            { label: "Date", render: (a) => date(a.date) },
            { label: "Invoice#", render: (a) => <Link to={`/invoices/${a.invoice}`}>{a.invoiceNumber}</Link> },
            { label: "Amount Credited", num: true, render: (a) => money(a.amount) },
            {
              label: "",
              num: true,
              render: (a) => (
                <button className="link-btn" onClick={() => act(() => api.delete(`/credit-notes/${id}/applications/${a._id}`), "Credit removed from invoice")}>
                  Remove
                </button>
              ),
            },
          ]}
        />
      )}
      {cn.refunds.length > 0 && (
        <MiniTable
          title="Refunds"
          rows={cn.refunds}
          columns={[
            { label: "Date", render: (r) => date(r.date) },
            { label: "Mode", render: (r) => modeName(r.mode) },
            { label: "Reference", render: (r) => r.reference },
            { label: "Amount", num: true, render: (r) => money(r.amount) },
            {
              label: "",
              num: true,
              render: (r) => (
                <button className="link-btn" onClick={() => act(() => api.delete(`/credit-notes/${id}/refunds/${r._id}`), "Refund deleted")}>
                  Delete
                </button>
              ),
            },
          ]}
        />
      )}

      <div className="doc-wrap">
        <DocPaper
          doc={cn}
          org={organization}
          title={K.docTitle}
          number={cn.number}
          ribbon={cn.status !== "draft" ? { text: cn.status, cls: cn.status } : null}
          balance={{ label: "Credits Remaining", value: cn.balance }}
          meta={[
            ["Credit Date", date(cn.date)],
            ["Invoice#", cn.invoiceNumber],
            ["Reference#", cn.reference],
          ]}
          extraInfo={cn.reason ? [["Reason", cn.reason]] : []}
          extraTotals={[
            usedAmt > 0 && ["Credits Used", <span>(-) {amount(usedAmt)}</span>],
            ["Credits Remaining", money(cn.balance), "doc-grand"],
          ].filter(Boolean)}
        />
      </div>

      <ApplyToInvoices cn={cn} open={modal === "apply"} onClose={() => setModal(null)} onDone={() => (setModal(null), load())} />
      <RefundModal cn={cn} open={modal === "refund"} onClose={() => setModal(null)} onDone={() => (setModal(null), load())} />
      <Confirm
        open={modal === "void"}
        title="Void this credit note?"
        text="It stays on record but the credit can no longer be used."
        confirmLabel="Void"
        onConfirm={() => act(() => api.post(`/credit-notes/${id}/void`), "Credit note voided")}
        onCancel={() => setModal(null)}
      />
      <Confirm
        open={modal === "delete"}
        title="Delete this credit note?"
        text="This can't be undone."
        onConfirm={async () => {
          try {
            await api.delete(`/credit-notes/${id}`);
            toast("Credit note deleted");
            navigate("/credit-notes");
          } catch (e) {
            setModal(null);
            toast(errMsg(e), "error");
          }
        }}
        onCancel={() => setModal(null)}
      />
    </>
  );
}
