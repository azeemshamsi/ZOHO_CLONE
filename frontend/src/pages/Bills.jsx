import BillFromPdf from "../components/BillFromPdf";
import { leaveTo } from "../lib/backNav";
import Attachments from "../components/Attachments";
import { Fragment, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import api, { errMsg } from "../lib/api";
import { useAuth } from "../lib/auth";
import { KINDS } from "../lib/docKinds";
import { PAYMENT_TERMS, modeName } from "../lib/constants";
import { money, amount, date, round2 } from "../lib/format";
import { PageHeader, Spinner, toast, Status, Confirm, MoreMenu, Modal } from "../components/ui";
import { DocList, DocForm, DocPaper, MiniTable } from "../components/SalesDoc";
import Icon from "../components/Icon";

const K = KINDS.bill;

// Bills paid by journal / debit note / marketplace settlement (not bill-wise) still look unpaid: match them to
// each supplier's ledger balance. Preview first; nothing is posted and Undo puts it back.
export function MatchLedger({ onClose, base = "/bills", party = "Supplier", doc = "Bill", credit = "Debit note" }) {
  const sales = base === "/invoices";
  const [groups, setGroups] = useState(null);
  const [pick, setPick] = useState({});
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState({});
  useEffect(() => {
    api
      .get(`${base}/ledger-match`)
      .then((r) => {
        setGroups(r.data);
        setPick(Object.fromEntries(r.data.map((g) => [g.vendor, true])));
      })
      .catch((e) => (toast(errMsg(e), "error"), setGroups([])));
  }, []);
  const chosen = Object.keys(pick).filter((k) => pick[k]);
  const run = async (undo) => {
    setBusy(true);
    try {
      const { data } = await api.post(undo ? `${base}/ledger-match/undo` : `${base}/ledger-match`, undo ? {} : { vendors: chosen });
      toast(undo ? `Undone on ${data.bills} ${doc.toLowerCase()}(s), ${data.credits} ${credit.toLowerCase()}(s)` : `Matched ${data.bills} ${doc.toLowerCase()}(s) and ${data.credits} ${credit.toLowerCase()}(s) for ${data.vendors} ${party.toLowerCase()}(s)`, "success");
      window.location.reload();
    } catch (e) {
      toast(errMsg(e), "error");
    }
    setBusy(false);
  };
  return (
    <Modal
      open
      wide
      title={`Match ${doc.toLowerCase()}s to the ledger`}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" disabled={busy} onClick={() => window.confirm(`Put back every ${doc.toLowerCase()} and ${credit.toLowerCase()} matched to the ledger?`) && run(true)} style={{ marginRight: "auto" }}>
            Undo earlier matching
          </button>
          <button className="btn" onClick={onClose}>
            Close
          </button>
          <button className="btn btn-primary" disabled={busy || !chosen.length} onClick={() => run(false)}>
            {busy ? "Matching…" : `Match ${chosen.length} ${party.toLowerCase()}(s)`}
          </button>
        </>
      }
    >
      <p className="small" style={{ marginTop: 0 }}>
        {sales
          ? "Invoices received by journal, cash / bank entry, credit note or a marketplace settlement (Amazon, Flipkart, Pepperfry) reduce the customer's ledger but were never set against an invoice, so they still show unpaid or overdue. This marks them received so the open invoices add up to the ledger balance: the newest invoices keep what's still due."
          : "Bills settled by journal, debit note or a marketplace settlement (Amazon, Flipkart) reduce the supplier's ledger but were never set against a bill, so the bills still show unpaid. This marks them settled so the open bills add up to the ledger balance: the newest bills keep what's still owed."}{" "}
        <strong>No entry is posted and no ledger balance changes</strong>; Undo puts them back.
      </p>
      {!groups ? (
        <Spinner />
      ) : !groups.length ? (
        <div className="muted">Every {party.toLowerCase()}'s open {doc.toLowerCase()}s already match their ledger.</div>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th style={{ width: 28 }} />
              <th>{party}</th>
              <th className="num">Ledger balance</th>
              <th className="num">Open {doc.toLowerCase()}s − {credit.toLowerCase()}s</th>
              <th className="num">After</th>
              <th className="num">Changes</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => (
              <Fragment key={g.vendor}>
                <tr>
                  <td>
                    <input type="checkbox" checked={!!pick[g.vendor]} onChange={(e) => setPick({ ...pick, [g.vendor]: e.target.checked })} />
                  </td>
                  <td>{g.name}</td>
                  <td className="num">{money(Math.abs(g.ledger))} {g.ledger === 0 ? "" : (g.ledger > 0) !== sales ? "Cr" : "Dr"}</td>
                  <td className="num">{money(g.billsDue - g.creditsOpen)}</td>
                  <td className="num">{money(g.after)}</td>
                  <td className="num">
                    <button type="button" className="link-btn" onClick={() => setOpen({ ...open, [g.vendor]: !open[g.vendor] })}>
                      {g.changes.length} {open[g.vendor] ? "▴" : "▾"}
                    </button>
                  </td>
                </tr>
                {open[g.vendor] &&
                  g.changes.map((c) => (
                    <tr key={c.id} className="small muted">
                      <td />
                      <td>
                        {c.type === "bill" ? doc : credit} {c.number} · {date(c.date)}
                      </td>
                      <td />
                      <td className="num">{money(c.balance)}</td>
                      <td className="num">{c.left ? `${money(c.left)} left` : "settled"}</td>
                      <td className="num">−{money(c.settle)}</td>
                    </tr>
                  ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      )}
    </Modal>
  );
}

export function BillList() {
  const [fromPdf, setFromPdf] = useState(false);
  const [match, setMatch] = useState(false);
  return (
    <>
    {fromPdf && <BillFromPdf kind="bill" onClose={() => setFromPdf(false)} />}
    {match && <MatchLedger onClose={() => setMatch(false)} />}
    <DocList
      kind={K}
      headerExtra={
        <>
          <button className="btn" onClick={() => setMatch(true)} title="Bills settled by journal / debit note / Amazon settlement: mark them paid from the supplier's ledger balance">
            Match to ledger
          </button>
          <button className="btn" onClick={() => setFromPdf(true)}>
            <Icon name="upload" size={16} /> From bill PDF
          </button>
        </>
      }
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
        { label: "Amount", num: true, render: (r) => money(r.total, r.currency) },
        { label: "Balance Due", num: true, render: (r) => money(r.balance, r.currency) },
      ]}
    />
    </>
  );
}

export const BillForm = () => <DocForm kind={K} />;

// Apply a vendor's open credits to this bill.
function ApplyVendorCredits({ bill, open, onClose, onDone }) {
  const [notes, setNotes] = useState(null);
  const [alloc, setAlloc] = useState({});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    api.get("/vendor-credits", { params: { vendor: bill.vendor, status: "open" } }).then((r) => {
      setNotes(r.data);
      let left = bill.balance;
      const pre = {};
      r.data.forEach((c) => {
        const x = round2(Math.min(left, c.balance));
        if (x > 0) pre[c._id] = x;
        left = round2(left - x);
      });
      setAlloc(pre);
    });
  }, [open, bill]);
  const applied = round2(Object.values(alloc).reduce((s, v) => s + (Number(v) || 0), 0));
  const save = async () => {
    if (applied > bill.balance) return toast("That's more than the bill balance", "error");
    setBusy(true);
    try {
      for (const [cid, v] of Object.entries(alloc)) {
        if (Number(v) > 0) await api.post(`/vendor-credits/${cid}/apply`, { allocations: [{ bill: bill._id, amount: Number(v) }] });
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
      title={`Apply vendor credits to bill ${bill.billNumber}`}
      footer={
        <>
          <span className="muted small" style={{ marginRight: "auto" }}>
            Bill balance {money(bill.balance, bill.currency)} · Applying {money(applied)}
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
      ) : !notes.length ? (
        <p className="muted">This vendor has no open credits.</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Vendor Credit#</th>
              <th>Date</th>
              <th className="num">Credits Available</th>
              <th className="num">Amount to Apply</th>
            </tr>
          </thead>
          <tbody>
            {notes.map((c) => (
              <tr key={c._id}>
                <td>{c.number}</td>
                <td>{date(c.date)}</td>
                <td className="num">{amount(c.balance)}</td>
                <td className="num">
                  <input className="pay-input" type="number" min="0" step="0.01" max={c.balance} value={alloc[c._id] ?? ""} onChange={(e) => setAlloc({ ...alloc, [c._id]: e.target.value })} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Modal>
  );
}

export function BillView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { organization } = useAuth();
  const [bill, setBill] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [credits, setCredits] = useState(0);
  const [applyOpen, setApplyOpen] = useState(false);

  const load = () =>
    api.get(`/bills/${id}`).then((r) => {
      setBill(r.data);
      api.get("/vendor-credits", { params: { vendor: r.data.vendor, status: "open" } }).then((c) => setCredits(round2(c.data.reduce((s, x) => s + x.balance, 0))));
    });
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
  const noMoney = bill.amountPaid === 0 && !bill.creditsApplied;
  const status = bill.displayStatus;

  return (
    <>
      <PageHeader title={`Bill ${bill.billNumber}`} subtitle={bill.vendorName} back="/bills">
        <Link to={`/bills/new?copy=${id}`} className="btn" title="Duplicate (Alt+2): a new voucher with these details, to change and save">
          Duplicate
        </Link>
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
            canPay && credits > 0 && { label: `Apply Credits (${money(credits)})`, onClick: () => setApplyOpen(true) },
            !["draft", "void"].includes(bill.status) && { label: "Create Vendor Credit", onClick: () => navigate(`/vendor-credits/new?bill=${id}`) },
            noMoney && bill.status !== "void" && { label: "Void", onClick: () => setConfirm("void") },
            noMoney && { label: "Delete", danger: true, onClick: () => setConfirm("delete") },
          ]}
        />
      </PageHeader>

      {canPay && credits > 0 && (
        <div className="banner no-print">
          <span>
            This vendor has given you <strong>{money(credits)}</strong> in credits you can use on this bill.
          </span>
          <button className="btn btn-sm btn-primary" onClick={() => setApplyOpen(true)}>
            Apply Credits
          </button>
        </div>
      )}
      {bill.purchaseOrder && (
        <p className="muted small no-print">
          Created from <Link to={`/purchase-orders/${bill.purchaseOrder}`}>purchase order {bill.orderNumber}</Link>
        </p>
      )}
      {bill.credits?.length > 0 && (
        <MiniTable
          title="Vendor Credits Applied"
          rows={bill.credits}
          columns={[
            { label: "Date", render: (c) => date(c.date) },
            { label: "Vendor Credit#", render: (c) => <Link to={`/vendor-credits/${c._id}`}>{c.number}</Link> },
            { label: "Amount", num: true, render: (c) => money(c.amount, c.currency) },
          ]}
        />
      )}

      {bill.payments?.length > 0 && (
        <MiniTable
          title="Payments Made"
          rows={bill.payments}
          columns={[
            { label: "Date", render: (p) => date(p.date) },
            { label: "Payment#", render: (p) => <Link to={`/payments-made/${p._id}`}>{p.paymentNumber}</Link> },
            { label: "Mode", render: (p) => modeName(p.mode) },
            { label: "Reference", render: (p) => p.reference },
            { label: "Amount", num: true, render: (p) => money(p.amount, p.currency) },
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
            bill.creditsApplied > 0 && ["Vendor Credits", <span className="text-paid">(-) {amount(bill.creditsApplied)}</span>],
            ["Balance Due", money(bill.balance, bill.currency), "doc-grand"],
          ].filter(Boolean)}
        />
        <Attachments docType="bill" docId={bill._id} />
      </div>

      <ApplyVendorCredits bill={bill} open={applyOpen} onClose={() => setApplyOpen(false)} onDone={() => (setApplyOpen(false), load())} />
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
            leaveTo(navigate, "/bills");
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
