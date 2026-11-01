import Attachments from "../components/Attachments";
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import api, { errMsg } from "../lib/api";
import { useAuth } from "../lib/auth";
import { KINDS } from "../lib/docKinds";
import { money, date } from "../lib/format";
import { PageHeader, Spinner, toast, Status, Confirm, MoreMenu } from "../components/ui";
import { DocList, DocForm, DocPaper } from "../components/SalesDoc";
import Icon from "../components/Icon";
import { DocEmail } from "../components/EmailDoc";

const K = KINDS.quote;

// A quote turned into a sales order reads "Converted"; into an invoice, "Invoiced".
const quoteStatus = (q) => (q.status === "invoiced" && q.convertedTo?.kind === "salesOrder" ? "converted" : q.displayStatus);

export function QuoteList() {
  return (
    <DocList
      kind={K}
      filters={[
        ["all", "All Quotes"],
        ["draft", "Draft"],
        ["sent", "Sent"],
        ["accepted", "Accepted"],
        ["declined", "Declined"],
        ["expired", "Expired"],
        ["invoiced", "Invoiced / Converted"],
      ]}
      emptyText="Send customers a price before they buy. When they accept, turn it into a sales order or invoice in one click."
      columns={[
        { label: "Date", render: (r) => date(r.date) },
        { label: "Quote#", cls: "link strong", render: (r) => r.number },
        { label: "Reference#", render: (r) => r.reference },
        { label: "Customer Name", render: (r) => r.customerName },
        { label: "Status", render: (r) => <Status value={quoteStatus(r)} /> },
        { label: "Expiry Date", render: (r) => date(r.expiryDate) },
        { label: "Amount", num: true, render: (r) => money(r.total, r.currency) },
      ]}
    />
  );
}

export const QuoteForm = () => <DocForm kind={K} />;

export function QuoteView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { organization } = useAuth();
  const [q, setQ] = useState(null);
  const [confirm, setConfirm] = useState(false);

  const load = () => api.get(`/quotes/${id}`).then((r) => setQ(r.data));
  useEffect(() => {
    load();
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!q || !organization) return <Spinner />;

  const setStatus = async (status, msg) => {
    try {
      await api.post(`/quotes/${id}/status`, { status });
      toast(msg);
      load();
    } catch (e) {
      toast(errMsg(e), "error");
    }
  };
  const convert = async (to) => {
    try {
      const { data } = await api.post(`/quotes/${id}/convert-to-${to}`);
      toast(to === "invoice" ? `Invoice ${data.invoiceNumber} created as a draft` : `Sales order ${data.number} created`);
      navigate(to === "invoice" ? `/invoices/${data._id}` : `/sales-orders/${data._id}`);
    } catch (e) {
      toast(errMsg(e), "error");
    }
  };

  const done = q.status === "invoiced";
  const status = quoteStatus(q);
  const conv = q.convertedTo;

  return (
    <>
      <PageHeader title={q.number} subtitle={q.customerName} back="/quotes">
        {!done && (
          <Link to={`/quotes/${id}/edit`} className="btn">
            <Icon name="edit" size={16} /> Edit
          </Link>
        )}
        <button className="btn" onClick={() => window.print()}>
          <Icon name="print" size={16} /> Print / PDF
        </button>
        <DocEmail kind="quote" id={id} onSent={load} />
        {q.status === "draft" && (
          <button className="btn" onClick={() => setStatus("sent", "Marked as sent")}>
            Mark as Sent
          </button>
        )}
        {!done && (
          <button className="btn btn-primary" onClick={() => convert("invoice")}>
            Convert to Invoice
          </button>
        )}
        <MoreMenu
          items={[
            !done && { label: "Convert to Sales Order", onClick: () => convert("sales-order") },
            !done && q.status !== "accepted" && { label: "Mark as Accepted", onClick: () => setStatus("accepted", "Quote accepted") },
            !done && q.status !== "declined" && { label: "Mark as Declined", onClick: () => setStatus("declined", "Quote declined") },
            !done && { label: "Delete", danger: true, onClick: () => setConfirm(true) },
          ]}
        />
      </PageHeader>

      {done && conv && (
        <div className="banner banner-green no-print">
          <span>
            This quote was converted to {conv.kind === "invoice" ? "invoice" : "sales order"}{" "}
            <Link to={conv.kind === "invoice" ? `/invoices/${conv.id}` : `/sales-orders/${conv.id}`}>
              <strong>{conv.number}</strong>
            </Link>
            .
          </span>
        </div>
      )}
      {q.status === "accepted" && (
        <div className="banner no-print">
          <span>The customer accepted this quote. Ready to bill?</span>
          <span className="page-actions">
            <button className="btn btn-sm" onClick={() => convert("sales-order")}>
              Convert to Sales Order
            </button>
            <button className="btn btn-sm btn-primary" onClick={() => convert("invoice")}>
              Convert to Invoice
            </button>
          </span>
        </div>
      )}

      <div className="doc-wrap">
        <DocPaper
          doc={q}
          org={organization}
          title={K.docTitle}
          number={q.number}
          ribbon={status !== "draft" ? { text: status, cls: status } : null}
          meta={[
            ["Quote Date", date(q.date)],
            ["Expiry Date", q.expiryDate && date(q.expiryDate)],
            ["Reference#", q.reference],
          ]}
        />
        <Attachments docType="quote" docId={q._id} />
      </div>
      <Confirm
        open={confirm}
        title="Delete this quote?"
        text="This can't be undone."
        onConfirm={async () => {
          try {
            await api.delete(`/quotes/${id}`);
            toast("Quote deleted");
            navigate("/quotes");
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
