import { useEffect, useRef, useState } from "react";
import api, { errMsg } from "../lib/api";
import { date } from "../lib/format";
import { PageHeader, Spinner, Modal, SearchBox, useDebounced } from "../components/ui";
import Icon from "../components/Icon";

// Stock Room: product photos with stock on hand, straight from the inventory (read-only). Scroll for more.
const BATCH = 40;

export default function StockRoom() {
  const [q, setQ] = useState("");
  const dq = useDebounced(q, 300);
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [open, setOpen] = useState(null);
  const ask = useRef(0);

  const load = async (offset) => {
    const my = ++ask.current;
    setLoading(true);
    try {
      const { data } = await api.get("/stock-room", { params: { q: dq, offset, limit: BATCH } });
      if (my !== ask.current) return;
      setRows((r) => (offset ? [...r, ...data.rows] : data.rows));
      setTotal(data.total);
      setErr("");
    } catch (e) {
      if (my === ask.current) setErr(errMsg(e));
    }
    if (my === ask.current) setLoading(false);
  };
  useEffect(() => {
    setRows([]);
    load(0);
  }, [dq]);

  // Next batch when the bottom comes into view.
  const end = useRef();
  useEffect(() => {
    if (!end.current || loading || rows.length >= total) return;
    const io = new IntersectionObserver((e) => e[0].isIntersecting && load(rows.length), { rootMargin: "600px" });
    io.observe(end.current);
    return () => io.disconnect();
  }, [rows.length, total, loading]);

  return (
    <div className="stock-room">
      <PageHeader title="Stock Room" subtitle="Stock on hand from the inventory · bills add, invoices take away" />
      <div className="card" style={{ padding: 12, marginBottom: 14 }}>
        <SearchBox value={q} onChange={setQ} placeholder="Search by name or SKU…" />
      </div>
      {err && <p className="alert alert-warn">{err}</p>}
      <div className="sr-grid">
        {rows.map((r) => (
          <div key={r._id} className="sr-card card">
            <button type="button" className="sr-img" onClick={() => setOpen(r)} title="History">
              {r.image ? <img src={r.image} alt="" loading="lazy" /> : <Icon name="box" size={42} />}
              <span className={`sr-qty ${r.qty > 0 ? "in" : "out"}`}>Qty: {r.qty}</span>
            </button>
            <div className="sr-body">
              <div className="sr-name" title={r.name}>
                {r.name}
              </div>
              <div className="muted small">SKU: {r.sku || "—"}</div>
              <button type="button" className="btn btn-sm sr-hist" onClick={() => setOpen(r)}>
                <Icon name="clock" size={14} /> History
              </button>
            </div>
          </div>
        ))}
      </div>
      <div ref={end} className="pager">
        {loading ? (
          <Spinner />
        ) : (
          <span className="muted small">
            {total ? `Showing ${rows.length} of ${total}` : !err ? (q ? "No products match" : "No products yet") : ""}
          </span>
        )}
      </div>
      {open && <History item={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function History({ item, onClose }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    api
      .get(`/stock-room/${item._id}/history`)
      .then((r) => setD(r.data))
      .catch((e) => setErr(errMsg(e)));
  }, [item._id]);
  return (
    <Modal open wide title={`${item.name}${item.sku ? ` · ${item.sku}` : ""}`} onClose={onClose}>
      <div style={{ display: "flex", gap: 14, alignItems: "center", marginBottom: 10 }}>
        {item.image ? <img src={item.image} alt="" className="sr-thumb" /> : null}
        <div>
          <div className="muted small">In stock now</div>
          <div style={{ fontSize: 26, fontWeight: 700 }}>{d ? d.qty : item.qty}</div>
        </div>
      </div>
      {err && <p className="alert alert-warn">{err}</p>}
      {!d && !err && <Spinner />}
      {d && !d.moves.length && <p className="muted">No ins or outs yet.</p>}
      {d && d.moves.length > 0 && (
        <div className="table-wrap">
          <table className="table compact">
            <thead>
              <tr>
                <th>Date</th>
                <th>Entry</th>
                <th>Party</th>
                <th className="num">In</th>
                <th className="num">Out</th>
                <th className="num">Balance</th>
              </tr>
            </thead>
            <tbody>
              {d.moves.map((m, i) => (
                <tr key={i}>
                  <td data-label="Date">{date(m.date)}</td>
                  <td data-label="Entry">
                    {m.type} {m.number}
                  </td>
                  <td data-label="Party" className="small">
                    {m.party}
                  </td>
                  <td data-label="In" className="num text-green">
                    {m.in || (m.transfer ? `⇄ ${m.transfer}` : "")}
                  </td>
                  <td data-label="Out" className="num text-red">
                    {m.out || ""}
                  </td>
                  <td data-label="Balance" className="num">
                    <strong>{m.balance}</strong>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {d.more && <p className="muted small">Latest 100 shown. The full history is in Items → Inventory.</p>}
        </div>
      )}
    </Modal>
  );
}
