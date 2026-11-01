import Attachments from "../components/Attachments";
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import api, { errMsg } from "../lib/api";
import { useAuth } from "../lib/auth";
import { KINDS } from "../lib/docKinds";
import { PAYMENT_TERMS, modeName } from "../lib/constants";
import { money, amount, date, round2 } from "../lib/format";
import { PageHeader, Spinner, toast, Status, Confirm, Modal, MoreMenu, invoiceStatus } from "../components/ui";
import { DocList, DocForm, DocPaper, MiniTable } from "../components/SalesDoc";
import Icon from "../components/Icon";
import { DocEmail } from "../components/EmailDoc";
import { GstPanel } from "../components/GstPanel";

const K = KINDS.invoice;

export function InvoiceList() {
  return (
    <DocList
      kind={K}
      filters={[
        ["all", "All Invoices"],
        ["draft", "Draft"],
        ["unpaid", "Unpaid"],
        ["overdue", "Overdue"],
        ["partially_paid", "Partially Paid"],
        ["paid", "Paid"],
        ["void", "Void"],
      ]}
      emptyText="GST is worked out automatically from your state and the customer's place of supply."
      summary={(rows) => (
        <>
          <span className="muted">{rows.length} invoices</span>
          <span>
            Balance due: <strong>{money(rows.filter((r) => !["void", "draft"].includes(r.status)).reduce((s, r) => s + r.balance, 0))}</strong>
          </span>
        </>
      )}
      columns={[
        { label: "Date", render: (r) => date(r.date) },
        { label: "Invoice#", cls: "link strong", render: (r) => r.invoiceNumber },
        { label: "Reference#", render: (r) => r.orderNumber },
        { label: "Customer Name", render: (r) => r.customerName },
        { label: "Status", render: (r) => <Status value={invoiceStatus(r.displayStatus)} /> },
        { label: "Due Date", render: (r) => date(r.dueDate) },
        { label: "Amount", num: true, render: (r) => money(r.total, r.currency) },
        { label: "Balance Due", num: true, render: (r) => money(r.balance, r.currency) },
      ]}
    />
  );
}

export const InvoiceForm = () => <DocForm kind={K} />;

// Apply a customer's open credit notes to this invoice.
function ApplyCredits({ inv, open, onClose, onDone }) {
  const [notes, setNotes] = useState(null);
  const [alloc, setAlloc] = useState({});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    api.get("/credit-notes", { params: { customer: inv.customer, status: "open" } }).then((r) => {
      setNotes(r.data);
      let left = inv.balance;
      const pre = {};
      r.data.forEach((c) => {
        const x = round2(Math.min(left, c.balance));
        if (x > 0) pre[c._id] = x;
        left = round2(left - x);
      });
      setAlloc(pre);
    });
  }, [open, inv]);
  const applied = round2(Object.values(alloc).reduce((s, v) => s + (Number(v) || 0), 0));
  const save = async () => {
    if (applied > inv.balance) return toast("That's more than the invoice balance", "error");
    setBusy(true);
    try {
      for (const [id, v] of Object.entries(alloc)) {
        if (Number(v) > 0) await api.post(`/credit-notes/${id}/apply`, { allocations: [{ invoice: inv._id, amount: Number(v) }] });
      }
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
      title={`Apply credits to ${inv.invoiceNumber}`}
      footer={
        <>
          <span className="muted small" style={{ marginRight: "auto" }}>
            Invoice balance {money(inv.balance, inv.currency)} · Applying {money(applied)}
          </span>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={busy || !applied} onClick={save}>
            Apply Credits
          </button>
        </>
      }
    >
      {!notes ? (
        <Spinner />
      ) : notes.length === 0 ? (
        <p className="muted">This customer has no open credit notes.</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Credit Note#</th>
              <th>Date</th>
              <th className="num">Credit Amount</th>
              <th className="num">Credits Available</th>
              <th className="num">Amount to Credit</th>
            </tr>
          </thead>
          <tbody>
            {notes.map((c) => (
              <tr key={c._id}>
                <td>{c.number}</td>
                <td>{date(c.date)}</td>
                <td className="num">{amount(c.total)}</td>
                <td className="num">{amount(c.balance)}</td>
                <td className="num">
                  <input
                    className="pay-input"
                    type="number"
                    min="0"
                    step="0.01"
                    max={c.balance}
                    value={alloc[c._id] ?? ""}
                    onChange={(e) => setAlloc({ ...alloc, [c._id]: e.target.value })}
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

export function InvoiceView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { organization } = useAuth();
  const [inv, setInv] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [credits, setCredits] = useState(0);
  const [applyOpen, setApplyOpen] = useState(false);

  const load = () =>
    api.get(`/invoices/${id}`).then((r) => {
      setInv(r.data);
      api
        .get("/credit-notes", { params: { customer: r.data.customer, status: "open" } })
        .then((c) => setCredits(round2(c.data.reduce((s, x) => s + x.balance, 0))));
    });
  useEffect(() => {
    load();
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!inv || !organization) return <Spinner />;

  const act = async (fn, msg) => {
    try {
      await fn();
      toast(msg);
      setConfirm(null);
      load();
    } catch (e) {
      setConfirm(null);
      toast(errMsg(e), "error");
    }
  };
  const status = invoiceStatus(inv.displayStatus);
  const noMoney = inv.amountPaid === 0 && inv.creditsApplied === 0;
  const canTakeMoney = inv.balance > 0 && !["void", "draft"].includes(inv.status);

  return (
    <>
      <PageHeader title={inv.invoiceNumber} subtitle={inv.customerName} back="/invoices">
        {inv.status !== "void" && (
          <Link to={`/invoices/${id}/edit`} className="btn">
            <Icon name="edit" size={16} /> Edit
          </Link>
        )}
        <button className="btn" onClick={() => window.print()}>
          <Icon name="print" size={16} /> Print / PDF
        </button>
        <DocEmail kind="invoice" id={id} onSent={load} reminder={inv.balance > 0 && ['sent','partially_paid'].includes(inv.status) && new Date(inv.dueDate) < new Date(new Date().toDateString())} />
        {inv.status === "draft" && (
          <button className="btn btn-primary" onClick={() => act(() => api.post(`/invoices/${id}/send`), "Marked as sent")}>
            Mark as Sent
          </button>
        )}
        {canTakeMoney && (
          <Link to={`/payments/new?customer=${inv.customer}&invoice=${id}`} className="btn btn-primary">
            Record Payment
          </Link>
        )}
        <MoreMenu
          items={[
            canTakeMoney && credits > 0 && { label: `Apply Credits (${money(credits)})`, onClick: () => setApplyOpen(true) },
            inv.status !== "draft" && inv.status !== "void" && { label: "Create Credit Note", onClick: () => navigate(`/credit-notes/new?invoice=${id}`) },
            noMoney && inv.status !== "void" && { label: "Void", onClick: () => setConfirm("void") },
            noMoney && { label: "Delete", danger: true, onClick: () => setConfirm("delete") },
          ]}
        />
      </PageHeader>

      {canTakeMoney && credits > 0 && (
        <div className="banner no-print">
          <span>
            This customer has <strong>{money(credits)}</strong> in credits you can use on this invoice.
          </span>
          <button className="btn btn-sm btn-primary" onClick={() => setApplyOpen(true)}>
            Apply Credits
          </button>
        </div>
      )}

      {inv.payments?.length > 0 && (
        <MiniTable
          title="Payments Received"
          rows={inv.payments}
          columns={[
            { label: "Date", render: (p) => date(p.date) },
            { label: "Payment#", render: (p) => <Link to={`/payments/${p._id}`}>{p.paymentNumber}</Link> },
            { label: "Mode", render: (p) => modeName(p.mode) },
            { label: "Reference", render: (p) => p.reference },
            { label: "Amount", num: true, render: (p) => money(p.amount, p.currency) },
          ]}
        />
      )}
      {inv.credits?.length > 0 && (
        <MiniTable
          title="Credits Applied"
          rows={inv.credits}
          columns={[
            { label: "Date", render: (c) => date(c.date) },
            { label: "Credit Note#", render: (c) => <Link to={`/credit-notes/${c._id}`}>{c.number}</Link> },
            { label: "Amount", num: true, render: (c) => money(c.amount, c.currency) },
          ]}
        />
      )}

      <GstPanel kind="invoice" doc={inv} onChanged={load} eligible={!!inv.customerGstin || (inv.currency && inv.currency !== "INR")} />
      <div className="doc-wrap">
        <DocPaper
          doc={inv}
          org={organization}
          title={K.docTitle}
          number={inv.invoiceNumber}
          ribbon={status !== "draft" ? { text: status.replace("_", " "), cls: status } : null}
          balance={{ label: "Balance Due", value: inv.balance }}
          meta={[
            ["Invoice Date", date(inv.date)],
            ["Terms", (PAYMENT_TERMS.find((p) => p[0] === inv.paymentTerms) || [0, `Net ${inv.paymentTerms}`])[1]],
            ["Due Date", date(inv.dueDate)],
            ["Reference#", inv.orderNumber],
          ]}
          extraTotals={[
            inv.amountPaid > 0 && ["Payment Made", <span className="text-paid">(-) {amount(inv.amountPaid)}</span>],
            inv.creditsApplied > 0 && ["Credits Applied", <span className="text-paid">(-) {amount(inv.creditsApplied)}</span>],
            ["Balance Due", money(inv.balance, inv.currency), "doc-grand"],
          ].filter(Boolean)}
        />
        <Attachments docType="invoice" docId={inv._id} />
      </div>

      <ApplyCredits inv={inv} open={applyOpen} onClose={() => setApplyOpen(false)} onDone={() => (setApplyOpen(false), load())} />
      <Confirm
        open={confirm === "void"}
        title="Void this invoice?"
        text="The invoice stays on record but its amount is no longer owed."
        confirmLabel="Void"
        onConfirm={() => act(() => api.post(`/invoices/${id}/void`), "Invoice voided")}
        onCancel={() => setConfirm(null)}
      />
      <Confirm
        open={confirm === "delete"}
        title="Delete this invoice?"
        text="This can't be undone. If it came from a quote or sales order, that document becomes available to convert again."
        onConfirm={async () => {
          try {
            await api.delete(`/invoices/${id}`);
            toast("Invoice deleted");
            navigate("/invoices");
          } catch (e) {
            setConfirm(null);
            toast(errMsg(e), "error");
          }
        }}
        onCancel={() => setConfirm(null)}
      />
    </>
  );
}
