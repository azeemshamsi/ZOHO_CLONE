import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import api, { errMsg } from "../lib/api";
import { useAuth } from "../lib/auth";
import { KINDS } from "../lib/docKinds";
import { PAYMENT_TERMS, modeName } from "../lib/constants";
import { money, amount, date } from "../lib/format";
import { PageHeader, Spinner, toast, Status, Confirm, MoreMenu } from "../components/ui";
import { DocList, DocForm, DocPaper, MiniTable } from "../components/SalesDoc";
import Icon from "../components/Icon";

const K = KINDS.bill;

export function BillList() {
  return (
    <DocList
      kind={K}
      filters={[
        ["all", "All Bills"],
        ["draft", "Draft"],
        ["unpaid", "Unpaid"],
        ["open", "Open"],
        ["overdue", "Overdue"],
        ["partially_paid", "Partially Paid"],
        ["paid", "Paid"],
        ["void", "Void"],
      ]}
      emptyText="Record the bills your vendors send you, so you know what you owe and when. GST paid becomes input tax credit."
      summary={(rows) => (
        <>
          <span className="muted">{rows.length} bills</span>
          <span>
            You owe: <strong>{money(rows.filter((r) => !["void", "draft"].includes(r.status)).reduce((s, r) => s + r.balance, 0))}</strong>
          </span>
        </>
      )}
      columns={[
        { label: "Date", render: (r) => date(r.date) },
        { label: "Bill#", cls: "link strong", render: (r) => r.billNumber },
        { label: "Reference Number", render: (r) => r.orderNumber },
        { label: "Vendor Name", render: (r) => r.vendorName },
        { label: "Status", render: (r) => <Status value={r.displayStatus} /> },
        { label: "Due Date", render: (r) => date(r.dueDate) },
        { label: "Amount", num: true, render: (r) => money(r.total) },
        { label: "Balance Due", num: true, render: (r) => money(r.balance) },
      ]}
    />
  );
}

export const BillForm = () => <DocForm kind={K} />;

export function BillView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { organization } = useAuth();
  const [bill, setBill] = useState(null);
  const [confirm, setConfirm] = useState(null);

  const load = () => api.get(`/bills/${id}`).then((r) => setBill(r.data));
  useEffect(() => {
    load();
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!bill || !organization) return <Spinner />;

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
  const canPay = bill.balance > 0 && !["void", "draft"].includes(bill.status);
  const status = bill.displayStatus;

  return (
    <>
      <PageHeader title={`Bill ${bill.billNumber}`} subtitle={bill.vendorName} back="/bills">
        {bill.status !== "void" && (
          <Link to={`/bills/${id}/edit`} className="btn">
            <Icon name="edit" size={16} /> Edit
          </Link>
        )}
        <button className="btn" onClick={() => window.print()}>
          <Icon name="print" size={16} /> Print / PDF
        </button>
        {bill.status === "draft" && (
          <button className="btn btn-primary" onClick={() => act(() => api.post(`/bills/${id}/open`), "Bill marked as open")}>
            Convert to Open
          </button>
        )}
        {canPay && (
          <Link to={`/payments-made/new?vendor=${bill.vendor}&bill=${id}`} className="btn btn-primary">
            Record Payment
          </Link>
        )}
        <MoreMenu
          items={[
            bill.amountPaid === 0 && bill.status !== "void" && { label: "Void", onClick: () => setConfirm("void") },
            bill.amountPaid === 0 && { label: "Delete", danger: true, onClick: () => setConfirm("delete") },
          ]}
        />
      </PageHeader>

      {bill.payments?.length > 0 && (
        <MiniTable
          title="Payments Made"
          rows={bill.payments}
          columns={[
            { label: "Date", render: (p) => date(p.date) },
            { label: "Payment#", render: (p) => <Link to={`/payments-made/${p._id}`}>{p.paymentNumber}</Link> },
            { label: "Mode", render: (p) => modeName(p.mode) },
            { label: "Reference", render: (p) => p.reference },
            { label: "Amount", num: true, render: (p) => money(p.amount) },
          ]}
        />
      )}

      <div className="doc-wrap">
        <DocPaper
          doc={bill}
          org={organization}
          title={K.docTitle}
          number={bill.billNumber}
          partyLabel="Bill From"
          ribbon={status !== "draft" ? { text: status.replace("_", " "), cls: status === "open" ? "unpaid" : status } : null}
          balance={{ label: "Balance Due", value: bill.balance }}
          meta={[
            ["Bill Date", date(bill.date)],
            ["Terms", (PAYMENT_TERMS.find((p) => p[0] === bill.paymentTerms) || [0, `Net ${bill.paymentTerms}`])[1]],
            ["Due Date", date(bill.dueDate)],
            ["Order#", bill.orderNumber],
          ]}
          extraTotals={[
            bill.amountPaid > 0 && ["Payments Made", <span className="text-paid">(-) {amount(bill.amountPaid)}</span>],
            ["Balance Due", money(bill.balance), "doc-grand"],
          ].filter(Boolean)}
        />
      </div>

      <Confirm
        open={confirm === "void"}
        title="Void this bill?"
        text="It stays on record but is no longer owed."
        confirmLabel="Void"
        onConfirm={() => act(() => api.post(`/bills/${id}/void`), "Bill voided")}
        onCancel={() => setConfirm(null)}
      />
      <Confirm
        open={confirm === "delete"}
        title="Delete this bill?"
        text="This can't be undone."
        onConfirm={async () => {
          try {
            await api.delete(`/bills/${id}`);
            toast("Bill deleted");
            navigate("/bills");
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
