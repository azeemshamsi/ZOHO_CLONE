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

const K = KINDS.salesOrder;

export function SalesOrderList() {
  return (
    <DocList
      kind={K}
      filters={[
        ["all", "All Sales Orders"],
        ["draft", "Draft"],
        ["confirmed", "Confirmed"],
        ["invoiced", "Invoiced"],
        ["cancelled", "Cancelled"],
      ]}
      emptyText="Record confirmed orders before you ship or bill them, then invoice them in one click."
      columns={[
        { label: "Date", render: (r) => date(r.date) },
        { label: "Sales Order#", cls: "link strong", render: (r) => r.number },
        { label: "Reference#", render: (r) => r.reference },
        { label: "Customer Name", render: (r) => r.customerName },
        { label: "Status", render: (r) => <Status value={r.status} /> },
        { label: "Invoiced", render: (r) => (r.invoiceNumber ? <span className="text-paid">● {r.invoiceNumber}</span> : <span className="muted">○</span>) },
        { label: "Shipment Date", render: (r) => date(r.shipmentDate) },
        { label: "Amount", num: true, render: (r) => money(r.total, r.currency) },
      ]}
    />
  );
}

export const SalesOrderForm = () => <DocForm kind={K} />;

export function SalesOrderView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { organization } = useAuth();
  const [so, setSo] = useState(null);
  const [confirm, setConfirm] = useState(null);

  const load = () => api.get(`/sales-orders/${id}`).then((r) => setSo(r.data));
  useEffect(() => {
    load();
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!so || !organization) return <Spinner />;

  const setStatus = async (status, msg) => {
    try {
      await api.post(`/sales-orders/${id}/status`, { status });
      toast(msg);
      setConfirm(null);
      load();
    } catch (e) {
      setConfirm(null);
      toast(errMsg(e), "error");
    }
  };
  const toInvoice = async () => {
    try {
      const { data } = await api.post(`/sales-orders/${id}/convert-to-invoice`);
      toast(`Invoice ${data.invoiceNumber} created as a draft`);
      navigate(`/invoices/${data._id}`);
    } catch (e) {
      toast(errMsg(e), "error");
    }
  };

  const open = !["invoiced", "cancelled"].includes(so.status);

  return (
    <>
      <PageHeader title={so.number} subtitle={so.customerName} back="/sales-orders">
        {open && (
          <Link to={`/sales-orders/${id}/edit`} className="btn">
            <Icon name="edit" size={16} /> Edit
          </Link>
        )}
        <button className="btn" onClick={() => window.print()}>
          <Icon name="print" size={16} /> Print / PDF
        </button>
        <DocEmail kind="salesOrder" id={id} onSent={load} />
        {so.status === "draft" && (
          <button className="btn" onClick={() => setStatus("confirmed", "Sales order confirmed")}>
            Confirm
          </button>
        )}
        {open && (
          <button className="btn btn-primary" onClick={toInvoice}>
            Convert to Invoice
          </button>
        )}
        <MoreMenu
          items={[
            open && { label: "Cancel Order", onClick: () => setConfirm("cancel") },
            so.status === "cancelled" && { label: "Reopen as Draft", onClick: () => setStatus("draft", "Sales order reopened") },
            !so.invoice && { label: "Delete", danger: true, onClick: () => setConfirm("delete") },
          ]}
        />
      </PageHeader>

      {so.invoice && (
        <div className="banner banner-green no-print">
          <span>
            Invoiced as{" "}
            <Link to={`/invoices/${so.invoice}`}>
              <strong>{so.invoiceNumber}</strong>
            </Link>
            .
          </span>
        </div>
      )}
      {so.quote && (
        <p className="muted small no-print">
          Created from quote <Link to={`/quotes/${so.quote}`}>{so.quoteNumber}</Link>
        </p>
      )}

      <div className="doc-wrap">
        <DocPaper
          doc={so}
          org={organization}
          title={K.docTitle}
          number={so.number}
          ribbon={so.status !== "draft" ? { text: so.status, cls: so.status } : null}
          meta={[
            ["Order Date", date(so.date)],
            ["Expected Shipment", so.shipmentDate && date(so.shipmentDate)],
            ["Reference#", so.reference],
          ]}
        />
      </div>
      <Confirm
        open={confirm === "cancel"}
        title="Cancel this sales order?"
        text="It stays on record but can't be invoiced. You can reopen it later."
        confirmLabel="Cancel Order"
        onConfirm={() => setStatus("cancelled", "Sales order cancelled")}
        onCancel={() => setConfirm(null)}
      />
      <Confirm
        open={confirm === "delete"}
        title="Delete this sales order?"
        text="This can't be undone. If it came from a quote, the quote becomes available to convert again."
        onConfirm={async () => {
          try {
            await api.delete(`/sales-orders/${id}`);
            toast("Sales order deleted");
            navigate("/sales-orders");
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
