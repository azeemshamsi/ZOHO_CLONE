import Attachments from "../components/Attachments";
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import api, { errMsg } from "../lib/api";
import { useAuth } from "../lib/auth";
import { KINDS } from "../lib/docKinds";
import { PAYMENT_MODES, modeName } from "../lib/constants";
import { money, amount, date, isoDate, round2 } from "../lib/format";
import { PageHeader, Spinner, toast, Status, Confirm, Modal, MoreMenu, Field } from "../components/ui";
import { DocList, DocForm, DocPaper, MiniTable } from "../components/SalesDoc";
import Icon from "../components/Icon";
import { DocEmail } from "../components/EmailDoc";
import BankAccountSelect from "../components/BankAccountSelect";


const K = KINDS.vendorCredit;

export function VendorCreditList() {
  return (
    <DocList
      kind={K}
      filters={[
        ["all", "All Vendor Credits"],
        ["draft", "Draft"],
        ["open", "Open"],
        ["closed", "Closed"],
        ["void", "Void"],
      ]}
      emptyText="Record credit a vendor gives you for returns, discounts or billing mistakes, then use it on their bills or record their refund."
      columns={[
        { label: "Date", render: (r) => date(r.date) },
        { label: "Vendor Credit#", cls: "link strong", render: (r) => r.number },
        { label: "Reference#", render: (r) => r.reference },
        { label: "Vendor Name", render: (r) => r.vendorName },
        { label: "Bill#", render: (r) => r.billNumber },
        { label: "Status", render: (r) => <Status value={r.status} /> },
        { label: "Amount", num: true, render: (r) => money(r.total, r.currency) },
        { label: "Balance", num: true, render: (r) => money(r.balance, r.currency) },
      ]}
    />
  );
}

export const VendorCreditForm = () => <DocForm kind={K} />;

function ApplyToInvoices({ cn, open, onClose, onDone }) {
  const [invoices, setInvoices] = useState(null);
  const [alloc, setAlloc] = useState({});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    api.get("/bills", { params: { vendor: cn.vendor, open: "1" } }).then((r) => {
      const list = r.data.filter((i) => i.status !== "draft" && i.balance > 0);
      setInvoices(list);
      // Pre-fill: the linked bill first, then oldest due.
      list.sort((a, b) => (String(a._id) === String(cn.bill) ? -1 : String(b._id) === String(cn.bill) ? 1 : new Date(a.dueDate) - new Date(b.dueDate)));
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
      await api.post(`/vendor-credits/${cn._id}/apply`, {
        allocations: Object.entries(alloc)
          .filter(([, v]) => Number(v) > 0)
          .map(([bill, v]) => ({ bill, amount: Number(v) })),
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
            Available {money(cn.balance, cn.currency)} · Applying {money(applied)}
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
        <p className="muted">This vendor has no unpaid bills. You can record a refund from them instead.</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Bill#</th>
              <th>Date</th>
              <th>Status</th>
              <th className="num">Bill Amount</th>
              <th className="num">Balance Due</th>
              <th className="num">Amount to Credit</th>
            </tr>
          </thead>
          <tbody>
            {invoices.map((i) => (
              <tr key={i._id}>
                <td>{i.billNumber}</td>
                <td>{date(i.date)}</td>
                <td>
                  <Status value={i.displayStatus} />
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
      await api.post(`/vendor-credits/${cn._id}/refund`, { ...f, amount: Number(f.amount) });
      toast("Refund recorded");
      onDone();
    } catch (err) {
      toast(errMsg(err), "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={open} onClose={onClose} title={`Refund received for ${cn.number}`}>
      <form className="stack" onSubmit={save}>
        <Field label="Amount (₹)" required hint={`Available: ${money(cn.balance, cn.currency)}`}>
          <input type="number" required min="0.01" step="0.01" max={cn.balance} value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} />
        </Field>
        <div className="row-2">
          <Field label="Received On" required>
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
          <BankAccountSelect label="Deposit To" value={f.bankAccount} mode={f.mode} onChange={(v) => setF({ ...f, bankAccount: v })} />
          <Field label="Reference#">
            <input value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} />
          </Field>
        </div>
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

export function VendorCreditView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { organization } = useAuth();
  const [cn, setCn] = useState(null);
  const [modal, setModal] = useState(null);

  const load = () => api.get(`/vendor-credits/${id}`).then((r) => setCn(r.data));
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
      <PageHeader title={cn.number} subtitle={cn.vendorName} back="/vendor-credits">
        {cn.status !== "void" && (
          <Link to={`/vendor-credits/${id}/edit`} className="btn">
            <Icon name="edit" size={16} /> Edit
          </Link>
        )}
        <button className="btn" onClick={() => window.print()}>
          <Icon name="print" size={16} /> Print / PDF
        </button>
        <DocEmail kind="vendorCredit" id={id} onSent={load} />
        {cn.status === "draft" && (
          <button className="btn btn-primary" onClick={() => act(() => api.post(`/vendor-credits/${id}/open`), "Vendor credit opened")}>
            Convert to Open
          </button>
        )}
        {isOpen && (
          <button className="btn btn-primary" onClick={() => setModal("apply")}>
            Apply to Bills
          </button>
        )}
        <MoreMenu
          items={[
            isOpen && { label: "Record Refund", onClick: () => setModal("refund") },
            usedAmt === 0 && cn.status !== "void" && { label: "Void", onClick: () => setModal("void") },
            usedAmt === 0 && { label: "Delete", danger: true, onClick: () => setModal("delete") },
          ]}
        />
      </PageHeader>

      {isOpen && (
        <div className="banner banner-amber no-print">
          <span>
            <strong>{money(cn.balance, cn.currency)}</strong> of credit is still available.
          </span>
          <span className="page-actions">
            <button className="btn btn-sm" onClick={() => setModal("refund")}>
              Refund
            </button>
            <button className="btn btn-sm btn-primary" onClick={() => setModal("apply")}>
              Apply to Bills
            </button>
          </span>
        </div>
      )}

      {cn.applications.length > 0 && (
        <MiniTable
          title="Bills Credited"
          rows={cn.applications}
          columns={[
            { label: "Date", render: (a) => date(a.date) },
            { label: "Bill#", render: (a) => <Link to={`/bills/${a.bill}`}>{a.billNumber}</Link> },
            { label: "Amount Credited", num: true, render: (a) => money(a.amount) },
            {
              label: "",
              num: true,
              render: (a) => (
                <button className="link-btn" onClick={() => act(() => api.delete(`/vendor-credits/${id}/applications/${a._id}`), "Credit removed from bill")}>
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
            { label: "Amount", num: true, render: (r) => money(r.amount, r.currency) },
            {
              label: "",
              num: true,
              render: (r) => (
                <button className="link-btn" onClick={() => act(() => api.delete(`/vendor-credits/${id}/refunds/${r._id}`), "Refund deleted")}>
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
          partyLabel="Vendor"
          meta={[
            ["Credit Date", date(cn.date)],
            ["Bill#", cn.billNumber],
            ["Reference#", cn.reference],
          ]}
          extraInfo={cn.reason ? [["Reason", cn.reason]] : []}
          extraTotals={[
            usedAmt > 0 && ["Credits Used", <span>(-) {amount(usedAmt)}</span>],
            ["Credits Remaining", money(cn.balance, cn.currency), "doc-grand"],
          ].filter(Boolean)}
        />
        <Attachments docType="vendorCredit" docId={cn._id} />
      </div>

      <ApplyToInvoices cn={cn} open={modal === "apply"} onClose={() => setModal(null)} onDone={() => (setModal(null), load())} />
      <RefundModal cn={cn} open={modal === "refund"} onClose={() => setModal(null)} onDone={() => (setModal(null), load())} />
      <Confirm
        open={modal === "void"}
        title="Void this vendor credit?"
        text="It stays on record but the credit can no longer be used."
        confirmLabel="Void"
        onConfirm={() => act(() => api.post(`/vendor-credits/${id}/void`), "Vendor credit voided")}
        onCancel={() => setModal(null)}
      />
      <Confirm
        open={modal === "delete"}
        title="Delete this vendor credit?"
        text="This can't be undone."
        onConfirm={async () => {
          try {
            await api.delete(`/vendor-credits/${id}`);
            toast("Vendor credit deleted");
            navigate("/vendor-credits");
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
