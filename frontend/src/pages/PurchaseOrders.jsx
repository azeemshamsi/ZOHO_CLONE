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

const K = KINDS.purchaseOrder;

export function PurchaseOrderList() {
  return (
    <DocList
      kind={K}
      filters={[
        ["all", "All Purchase Orders"],
        ["draft", "Draft"],
        ["issued", "Issued"],
        ["billed", "Billed"],
        ["cancelled", "Cancelled"],
      ]}
      emptyText="Send vendors a purchase order before they deliver. When their bill arrives, turn the PO into a bill in one click."
      columns={[
        { label: "Date", render: (r) => date(r.date) },
        { label: "Purchase Order#", cls: "link strong", render: (r) => r.number },
        { label: "Reference#", render: (r) => r.reference },
        { label: "Vendor Name", render: (r) => r.vendorName },
        { label: "Status", render: (r) => <Status value={r.status} /> },
        { label: "Billed", render: (r) => (r.billNumber ? <span className="text-paid">● {r.billNumber}</span> : <span className="muted">○</span>) },
        { label: "Delivery Date", render: (r) => date(r.deliveryDate) },
        { label: "Amount", num: true, render: (r) => money(r.total, r.currency) },
      ]}
    />
  );
}

export const PurchaseOrderForm = () => <DocForm kind={K} />;

export function PurchaseOrderView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { organization } = useAuth();
  const [po, setPo] = useState(null);
  const [confirm, setConfirm] = useState(null);

  const load = () => api.get(`/purchase-orders/${id}`).then((r) => setPo(r.data));
  useEffect(() => {
    load();
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!po || !organization) return <Spinner />;

  const setStatus = async (status, msg) => {
    try {
      await api.post(`/purchase-orders/${id}/status`, { status });
      toast(msg);
      setConfirm(null);
      load();
    } catch (e) {
      setConfirm(null);
      toast(errMsg(e), "error");
    }
  };
  const open = !["billed", "cancelled"].includes(po.status);

  return (
    <>
      <PageHeader title={po.number} subtitle={po.vendorName} back="/purchase-orders">
        {open && (
          <Link to={`/purchase-orders/${id}/edit`} className="btn">
            <Icon name="edit" size={16} /> Edit
          </Link>
        )}
        <button className="btn" onClick={() => window.print()}>
          <Icon name="print" size={16} /> Print / PDF
        </button>
        <DocEmail kind="purchaseOrder" id={id} onSent={load} />
        {po.status === "draft" && (
          <button className="btn" onClick={() => setStatus("issued", "Purchase order issued")}>
            Mark as Issued
          </button>
        )}
        {open && (
          <button className="btn btn-primary" onClick={() => navigate(`/bills/new?po=${id}`)}>
            Convert to Bill
          </button>
        )}
        <MoreMenu
          items={[
            open && { label: "Cancel Order", onClick: () => setConfirm("cancel") },
            po.status === "cancelled" && { label: "Reopen as Draft", onClick: () => setStatus("draft", "Purchase order reopened") },
            !po.bill && { label: "Delete", danger: true, onClick: () => setConfirm("delete") },
          ]}
        />
      </PageHeader>

      {po.bill && (
        <div className="banner banner-green no-print">
          <span>
            Billed as{" "}
            <Link to={`/bills/${po.bill}`}>
              <strong>{po.billNumber}</strong>
            </Link>
            .
          </span>
        </div>
      )}

      <div className="doc-wrap">
        <DocPaper
          doc={po}
          org={organization}
          title={K.docTitle}
          number={po.number}
          partyLabel="Vendor"
          ribbon={po.status !== "draft" ? { text: po.status, cls: po.status === "issued" ? "sent" : po.status === "billed" ? "invoiced" : po.status } : null}
          meta={[
            ["Order Date", date(po.date)],
            ["Expected Delivery", po.deliveryDate && date(po.deliveryDate)],
            ["Reference#", po.reference],
          ]}
        />
      </div>
      <Confirm
        open={confirm === "cancel"}
        title="Cancel this purchase order?"
        text="It stays on record but can't be billed. You can reopen it later."
        confirmLabel="Cancel Order"
        onConfirm={() => setStatus("cancelled", "Purchase order cancelled")}
        onCancel={() => setConfirm(null)}
      />
      <Confirm
        open={confirm === "delete"}
        title="Delete this purchase order?"
        text="This can't be undone."
        onConfirm={async () => {
          try {
            await api.delete(`/purchase-orders/${id}`);
            toast("Purchase order deleted");
            navigate("/purchase-orders");
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
