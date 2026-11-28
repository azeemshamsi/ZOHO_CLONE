import { useEffect, useRef, useState } from "react";
import api, { errMsg } from "../lib/api";
import { useAuth } from "../lib/auth";
import { can } from "../components/Layout";
import { money } from "../lib/format";
import { PageHeader, Spinner, toast } from "../components/ui";

// Store → COD Pending: COD and part-paid orders (from 1 Apr 2026) whose cash the courier collected — or will
// collect — and hasn't paid us yet. Mark remittances received by hand or from the courier's remittance file.
const fmt = (d) => (d ? new Date(d).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "2-digit" }) : "");
const todayIst = () => new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 10);

export function CodPending() {
  const { user } = useAuth();
  const canEdit = can(user, "store_cod", "full");
  const [f, setF] = useState({ stage: "delivered", remit: "pending", account: "", courier: "", dateBy: "delivered", from: "", to: "", q: "" });
  const [d, setD] = useState(null);
  const [sel, setSel] = useState(new Set());
  const [busy, setBusy] = useState(false);
  const [mark, setMark] = useState(null); // { date, ref }
  const [imp, setImp] = useState(null);
  const file = useRef();
  const params = () => Object.fromEntries(Object.entries(f).filter(([, v]) => v !== ""));

  const load = () =>
    api
      .get("/shopify/cod", { params: params() })
      .then((r) => {
        setD(r.data);
        setSel(new Set());
      })
      .catch((e) => toast(errMsg(e), "error"));
  useEffect(() => {
    const t = setTimeout(load, f.q ? 350 : 0);
    return () => clearTimeout(t);
  }, [JSON.stringify(f)]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));

  const download = async () => {
    try {
      const r = await api.get("/shopify/cod/export", { params: params(), responseType: "blob" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(r.data);
      a.download = `cod-pending-${todayIst()}.xlsx`;
      a.click();
    } catch (e) {
      toast(errMsg(e), "error");
    }
  };
  const remit = async (undo) => {
    setBusy(true);
    try {
      const { data } = await api.post("/shopify/cod/remit", { ids: [...sel], undo, ...(undo ? {} : { date: mark.date, ref: mark.ref }) });
      toast(undo ? `${data.done} order(s) moved back to pending` : `${data.done} order(s) marked received`);
      setMark(null);
      load();
    } catch (e) {
      toast(errMsg(e), "error");
    }
    setBusy(false);
  };
  const upload = async (fl) => {
    if (!fl) return;
    setBusy(true);
    try {
      const data64 = await new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(String(r.result).split(",")[1]);
        r.onerror = rej;
        r.readAsDataURL(fl);
      });
      const { data } = await api.post("/shopify/cod/import", { name: fl.name, data: data64 });
      setImp(data);
      toast(`${data.marked} order(s) marked received from ${fl.name}`);
      load();
    } catch (e) {
      toast(errMsg(e), "error");
    }
    setBusy(false);
    if (file.current) file.current.value = "";
  };

  const rows = d?.rows || [];
  const allOn = rows.length > 0 && rows.every((r) => sel.has(r._id));
  const selAmount = rows.filter((r) => sel.has(r._id)).reduce((s, r) => s + r.amount, 0);
  const pickedReceived = rows.filter((r) => sel.has(r._id) && r.remit).length;
  const t = d?.summary?.total;

  return (
    <div>
      <PageHeader title="COD Pending" subtitle="Cash couriers have collected on COD and part-paid orders but not yet paid you — orders from 1 April 2026.">
        {canEdit && (
          <>
            <input ref={file} type="file" accept=".csv,.xls,.xlsx" style={{ display: "none" }} onChange={(e) => upload(e.target.files[0])} />
            <button className="btn" disabled={busy} onClick={() => file.current?.click()} title="Upload the courier's COD remittance file (CSV / Excel with an AWB column) to mark those orders received">
              Import remittance file
            </button>
          </>
        )}
        <button className="btn btn-primary" onClick={download}>
          Download Excel
        </button>
      </PageHeader>

      {t && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12, marginBottom: 16 }}>
          <div className="card" style={{ padding: 14 }}>
            <div className="muted small">Delivered — pending with couriers</div>
            <div style={{ fontSize: 22, fontWeight: 700, color: "#b91c1c" }}>{money(t.delivered)}</div>
            <div className="muted small">{t.deliveredCount} orders</div>
          </div>
          <div className="card" style={{ padding: 14 }}>
            <div className="muted small">In transit — still to be collected</div>
            <div style={{ fontSize: 22, fontWeight: 700 }}>{money(t.inTransit)}</div>
            <div className="muted small">{t.inTransitCount} orders</div>
          </div>
          <div className="card" style={{ padding: 14 }}>
            <div className="muted small">Received</div>
            <div style={{ fontSize: 22, fontWeight: 700, color: "#15803d" }}>{money(t.received)}</div>
            <div className="muted small">{t.receivedCount} orders</div>
          </div>
        </div>
      )}

      {d?.summary?.byAccount?.length > 0 && (
        <div className="card" style={{ padding: 0, marginBottom: 16, overflowX: "auto" }}>
          <table className="table">
            <thead>
              <tr>
                <th>Courier account</th>
                <th className="num">Delivered, pending</th>
                <th className="num">In transit</th>
                <th className="num">Received</th>
              </tr>
            </thead>
            <tbody>
              {d.summary.byAccount.map((a) => (
                <tr key={a.account} style={{ cursor: "pointer" }} onClick={() => setF((x) => ({ ...x, account: x.account === a.account ? "" : a.account }))} title="Show only this courier account">
                  <td>
                    <strong>{a.account}</strong> {f.account === a.account && <span className="muted small">(filtered)</span>}
                  </td>
                  <td className="num text-overdue">
                    {money(a.delivered)} <span className="muted small">· {a.deliveredCount}</span>
                  </td>
                  <td className="num">
                    {money(a.inTransit)} <span className="muted small">· {a.inTransitCount}</span>
                  </td>
                  <td className="num text-paid">
                    {money(a.received)} <span className="muted small">· {a.receivedCount}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="card" style={{ padding: 12, marginBottom: 12, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <select value={f.stage} onChange={set("stage")}>
          <option value="delivered">Delivered</option>
          <option value="in_transit">In transit</option>
          <option value="all">Delivered + in transit</option>
        </select>
        <select value={f.remit} onChange={set("remit")}>
          <option value="pending">Payment pending</option>
          <option value="received">Received</option>
          <option value="all">Pending + received</option>
        </select>
        <select value={f.account} onChange={set("account")}>
          <option value="">All courier accounts</option>
          {(d?.accounts || []).map((a) => (
            <option key={a}>{a}</option>
          ))}
        </select>
        <select value={f.courier} onChange={set("courier")}>
          <option value="">All couriers</option>
          {(d?.couriers || []).map((a) => (
            <option key={a}>{a}</option>
          ))}
        </select>
        <select value={f.dateBy} onChange={set("dateBy")} title="Which date the From / To filter uses">
          <option value="delivered">Delivered date</option>
          <option value="order">Order date</option>
        </select>
        <input type="date" value={f.from} min="2026-04-01" onChange={set("from")} />
        <span className="muted">to</span>
        <input type="date" value={f.to} min="2026-04-01" onChange={set("to")} />
        <input value={f.q} onChange={set("q")} placeholder="Order no. / AWB / customer" style={{ width: 190 }} />
        {(f.from || f.to || f.account || f.courier || f.q) && (
          <button className="link-btn" onClick={() => setF((x) => ({ ...x, from: "", to: "", account: "", courier: "", q: "" }))}>
            Clear
          </button>
        )}
      </div>

      {imp && (
        <div className="alert" style={{ marginBottom: 12, background: "#f0fdf4" }}>
          <strong>Remittance file:</strong> {imp.marked} marked received · {imp.already} were already received
          {imp.notFound.length > 0 && ` · ${imp.notFound.length} AWB(s) not found among COD orders since 1 Apr (${imp.notFound.slice(0, 8).join(", ")}${imp.notFound.length > 8 ? "…" : ""})`}
          {imp.amountDiff.length > 0 && (
            <div className="small" style={{ color: "#b45309", marginTop: 4 }}>
              ⚠ Amount different from the order: {imp.amountDiff.slice(0, 10).map((x) => `${x.order} expected ${money(x.expected)}, paid ${money(x.paid)}`).join(" · ")}
            </div>
          )}{" "}
          <button className="link-btn" onClick={() => setImp(null)}>
            Close
          </button>
        </div>
      )}

      {canEdit && sel.size > 0 && (
        <div className="bulk-bar" style={{ marginBottom: 8 }}>
          <strong>
            {sel.size} selected · {money(selAmount)}
          </strong>
          {!mark ? (
            <>
              {pickedReceived < sel.size && (
                <button className="btn btn-sm btn-primary" onClick={() => setMark({ date: todayIst(), ref: "" })}>
                  Mark received
                </button>
              )}
              {pickedReceived > 0 && (
                <button className="btn btn-sm" disabled={busy} onClick={() => remit(true)}>
                  Move back to pending
                </button>
              )}
            </>
          ) : (
            <>
              <input type="date" value={mark.date} onChange={(e) => setMark({ ...mark, date: e.target.value })} />
              <input value={mark.ref} onChange={(e) => setMark({ ...mark, ref: e.target.value })} placeholder="UTR / remittance no." style={{ width: 170 }} />
              <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => remit(false)}>
                Save
              </button>
              <button className="link-btn" onClick={() => setMark(null)}>
                Cancel
              </button>
            </>
          )}
          <button className="link-btn" onClick={() => setSel(new Set())}>
            Clear
          </button>
        </div>
      )}

      {!d ? (
        <Spinner />
      ) : !rows.length ? (
        <div className="card" style={{ padding: 24 }}>
          <p className="muted" style={{ margin: 0 }}>No orders match these filters.</p>
        </div>
      ) : (
        <div className="card flush" style={{ overflowX: "auto" }}>
          <table className="table">
            <thead>
              <tr>
                {canEdit && (
                  <th style={{ width: 34 }}>
                    <input type="checkbox" checked={allOn} onChange={() => setSel(allOn ? new Set() : new Set(rows.map((r) => r._id)))} aria-label="Select all" />
                  </th>
                )}
                <th>Order</th>
                <th>Ordered</th>
                <th>Delivered</th>
                <th>Courier</th>
                <th>AWB</th>
                <th>Customer</th>
                <th className="num">Due from courier</th>
                <th>Payment</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r._id} className={sel.has(r._id) ? "row-selected" : ""}>
                  {canEdit && (
                    <td>
                      <input
                        type="checkbox"
                        checked={sel.has(r._id)}
                        onChange={() =>
                          setSel((s) => {
                            const n = new Set(s);
                            n.has(r._id) ? n.delete(r._id) : n.add(r._id);
                            return n;
                          })
                        }
                      />
                    </td>
                  )}
                  <td>
                    <strong>{r.name}</strong>
                    {r.paymentMode === "partial" && <span className="tag">Part-paid</span>}
                  </td>
                  <td className="nowrap small">{fmt(r.orderDate)}</td>
                  <td className="nowrap small">{r.stage === "delivered" ? fmt(r.deliveredAt) : <span className="muted">In transit</span>}</td>
                  <td className="small">
                    {r.account}
                    {r.courier && r.courier !== r.account && <div className="muted">{r.courier}</div>}
                  </td>
                  <td className="mono small">{r.awbs.join(", ")}</td>
                  <td className="small">
                    {r.customer}
                    {r.city && <div className="muted">{r.city}</div>}
                  </td>
                  <td className="num">
                    <strong>{money(r.amount)}</strong>
                  </td>
                  <td className="small">
                    {r.remit ? (
                      <span className="text-paid" title={r.remit.byName ? `by ${r.remit.byName}` : ""}>
                        Received {fmt(r.remit.at)}
                        {r.remit.ref ? ` · ${r.remit.ref}` : ""}
                      </span>
                    ) : (
                      <span className="text-overdue">Pending</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="muted small" style={{ marginTop: 8 }}>
        Counts COD and part-paid orders ordered on or after 1 April 2026. Delivered orders (also those returned after delivery) are pending until marked received; RTO, cancelled and unshipped orders aren't
        counted. Remittance files need an AWB column; an amount column, date and UTR are read too if present.
      </p>
    </div>
  );
}
