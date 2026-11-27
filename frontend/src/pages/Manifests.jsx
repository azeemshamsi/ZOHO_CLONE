import { useEffect, useMemo, useRef, useState } from "react";
import api, { errMsg } from "../lib/api";
import { useAuth } from "../lib/auth";
import { can } from "../components/Layout";
import { PageHeader, toast } from "../components/ui";
import { MarketplaceSelect } from "./AwbScan";

// Courier handover manifests: pick or scan the parcels going with a pickup, create the manifest (MF-00001…),
// print it on A5 for the courier executive's signature, and find past manifests by date, AWB or order number.
const fmt = (t) =>
  t ? new Date(t).toLocaleString("en-IN", { day: "2-digit", month: "short", year: "2-digit", hour: "2-digit", minute: "2-digit" }) : "";
const todayIst = () => new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 10);

async function openManifest(m, paper = "A5", download = false) {
  const w = download ? null : window.open("", "_blank");
  try {
    const r = await api.get(`/shopify/manifests/${m._id}/pdf`, { params: { paper }, responseType: "blob" });
    const url = URL.createObjectURL(r.data);
    if (download) {
      const a = document.createElement("a");
      a.href = url;
      a.download = `manifest-${m.number}${paper === "A4" ? "-A4" : ""}.pdf`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    } else if (w) w.location = url;
    else window.open(url, "_blank");
  } catch (e) {
    if (w) w.close();
    toast(errMsg(e), "error");
  }
}

function downloadCsv(m) {
  const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = [
    ["#", "AWB Number", "Order No.", "Marketplace", "Courier", "Date & Time"].map(q).join(","),
    ...m.rows.map((r, i) => [i + 1, r.awb, `${r.orderName || ""}${r.box ? ` (${r.box})` : ""}`, r.channel, r.courier, fmt(r.at)].map(q).join(",")),
  ];
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([`Manifest ${m.number} · ${fmt(m.createdAt)}\n` + lines.join("\n")], { type: "text/csv" }));
  a.download = `manifest-${m.number}.csv`;
  a.click();
}

export function Manifests() {
  const { user } = useAuth();
  const [version, setVersion] = useState(0);
  return (
    <div>
      <PageHeader title="Manifests" subtitle="Parcels handed to a courier's pickup: create the manifest, print it on A5 and get it signed." />
      <NewManifest onCreated={() => setVersion((v) => v + 1)} />
      <ManifestHistory version={version} canDelete={can(user, "store_shipping", "full")} />
    </div>
  );
}

function NewManifest({ onCreated }) {
  const [rows, setRows] = useState([]);
  const [code, setCode] = useState("");
  const [channel, setChannel] = useState("");
  const [courier, setCourier] = useState("");
  const [problems, setProblems] = useState([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [pending, setPending] = useState(null);
  const input = useRef();

  const add = (list) => {
    setRows((cur) => {
      const have = new Set(cur.map((r) => r.awb));
      return [...cur, ...list.filter((r) => !have.has(r.awb))];
    });
  };

  const scan = async (e) => {
    e?.preventDefault();
    const codes = code.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
    if (!codes.length || busy) return;
    setBusy(true);
    try {
      const { data } = await api.post("/shopify/manifests/lookup", { codes, channel, courier });
      const dupes = data.rows.filter((r) => rows.some((x) => x.awb === r.awb));
      add(data.rows);
      setProblems([...data.problems, ...dupes.map((r) => ({ code: r.awb, message: `${r.awb} is already in this list` }))]);
      setCode("");
    } catch (err) {
      setProblems([{ code: codes[0], message: errMsg(err) }]);
    }
    setBusy(false);
    setTimeout(() => input.current?.focus(), 30);
  };

  const create = async () => {
    if (!rows.length) return;
    setBusy(true);
    try {
      const { data } = await api.post("/shopify/manifests", { rows: rows.map(({ awb, channel, courier }) => ({ awb, channel, courier })), note });
      toast(`Manifest ${data.number} created · ${data.count} parcel${data.count === 1 ? "" : "s"}`);
      setRows([]);
      setNote("");
      setProblems([]);
      setPending(null);
      onCreated();
      openManifest(data, "A5");
    } catch (err) {
      toast(errMsg(err), "error");
    }
    setBusy(false);
  };

  const byCourier = rows.reduce((m, r) => ({ ...m, [r.courier || "—"]: (m[r.courier || "—"] || 0) + 1 }), {});
  return (
    <div className="card" style={{ padding: 16, marginBottom: 16 }}>
      <h3 style={{ marginTop: 0 }}>New manifest</h3>
      <form onSubmit={scan} style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <input
          ref={input}
          autoFocus
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="Scan or type AWB / order no."
          autoComplete="off"
          autoCapitalize="characters"
          style={{ flex: "1 1 220px", minWidth: 0 }}
        />
        <button className="btn btn-primary" disabled={busy || !code.trim()}>
          Add
        </button>
        <button type="button" className="btn" disabled={busy} onClick={() => setPending(pending ? null : "load")}>
          {pending ? "Hide pending parcels" : "Pick from pending parcels"}
        </button>
      </form>
      <div className="small" style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center", marginTop: 8 }}>
        <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
          AWBs not in OrdexaGo belong to
          <MarketplaceSelect value={channel} onChange={setChannel} />
        </label>
        <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
          with courier
          <input value={courier} onChange={(e) => setCourier(e.target.value)} placeholder="e.g. Ekart" style={{ width: 130 }} />
        </label>
      </div>
      <p className="muted small" style={{ margin: "6px 0 0" }}>
        A barcode scanner works here — it types the AWB and presses Enter. Several AWBs can be pasted at once.
      </p>
      {problems.length > 0 && (
        <div className="small" style={{ color: "var(--danger, #b91c1c)", marginTop: 8 }}>
          {problems.map((p, i) => (
            <div key={i}>• {p.message}</div>
          ))}
        </div>
      )}
      {pending && <PendingPicker onAdd={(list) => add(list)} added={rows} />}
      {rows.length > 0 && (
        <>
          <div className="label-sm" style={{ marginTop: 14 }}>
            {rows.length} parcel{rows.length === 1 ? "" : "s"} on this manifest
            {Object.keys(byCourier).length ? ` · ${Object.entries(byCourier).map(([c, n]) => `${c} ${n}`).join(", ")}` : ""}
          </div>
          <div style={{ overflowX: "auto" }}>
            <ManifestTable rows={rows} onRemove={(awb) => setRows((cur) => cur.filter((r) => r.awb !== awb))} />
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10, alignItems: "center" }}>
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional): pickup executive, vehicle…" style={{ flex: "1 1 220px", minWidth: 0 }} />
            <button className="btn" disabled={busy} onClick={() => window.confirm("Clear this list?") && setRows([])}>
              Clear
            </button>
            <button className="btn btn-primary" disabled={busy} onClick={create}>
              {busy ? "Creating…" : `Create manifest (${rows.length})`}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function ManifestTable({ rows, onRemove }) {
  return (
    <table className="table">
      <thead>
        <tr>
          <th>#</th>
          <th>AWB</th>
          <th>Order</th>
          <th>Marketplace</th>
          <th>Courier</th>
          <th>Date &amp; time</th>
          {onRemove && <th />}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={r.awb}>
            <td>{i + 1}</td>
            <td>
              <strong>{r.awb}</strong>
            </td>
            <td>
              {r.orderName || "—"}
              {r.box ? <span className="muted small"> box {r.box}</span> : null}
            </td>
            <td>{r.channel}</td>
            <td>{r.courier || "—"}</td>
            <td className="small">{fmt(r.at)}</td>
            {onRemove && (
              <td>
                <button className="btn btn-ghost btn-sm" title="Remove from this manifest" onClick={() => onRemove(r.awb)}>
                  ✕
                </button>
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// Booked parcels and scanned marketplace AWBs that aren't on any manifest yet, filtered by courier / marketplace.
function PendingPicker({ onAdd, added }) {
  const [days, setDays] = useState(3);
  const [list, setList] = useState(null);
  const [courier, setCourier] = useState("");
  const [channel, setChannel] = useState("");
  const [onlyScanned, setOnlyScanned] = useState(false);
  const [picked, setPicked] = useState(new Set());
  useEffect(() => {
    setList(null);
    api
      .get("/shopify/manifests/pending", { params: { days } })
      .then((r) => setList(r.data))
      .catch((e) => setList({ error: errMsg(e) }));
  }, [days]);
  const addedSet = new Set(added.map((r) => r.awb));
  const rows = useMemo(
    () =>
      Array.isArray(list)
        ? list.filter((r) => !addedSet.has(r.awb) && (!courier || r.courier === courier) && (!channel || r.channel === channel) && (!onlyScanned || r.scanned))
        : [],
    [list, courier, channel, onlyScanned, added], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const couriers = [...new Set((Array.isArray(list) ? list : []).map((r) => r.courier).filter(Boolean))].sort();
  const channels = [...new Set((Array.isArray(list) ? list : []).map((r) => r.channel).filter(Boolean))].sort();
  const allPicked = rows.length > 0 && rows.every((r) => picked.has(r.awb));
  const toggle = (awb) =>
    setPicked((p) => {
      const n = new Set(p);
      n.has(awb) ? n.delete(awb) : n.add(awb);
      return n;
    });
  return (
    <div style={{ border: "1px solid var(--border, #e5e7eb)", borderRadius: 8, padding: 12, marginTop: 12 }}>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }} className="small">
        <strong>Pending parcels</strong>
        <select value={courier} onChange={(e) => setCourier(e.target.value)}>
          <option value="">All couriers</option>
          {couriers.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
        <select value={channel} onChange={(e) => setChannel(e.target.value)}>
          <option value="">All marketplaces</option>
          {channels.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
        <label style={{ display: "flex", gap: 4, alignItems: "center" }}>
          <input type="checkbox" checked={onlyScanned} onChange={(e) => setOnlyScanned(e.target.checked)} /> only AWB-scanned
        </label>
        <label style={{ display: "flex", gap: 4, alignItems: "center" }}>
          shipped in last
          <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {[1, 2, 3, 7, 15, 30].map((d) => (
              <option key={d} value={d}>
                {d} day{d > 1 ? "s" : ""}
              </option>
            ))}
          </select>
        </label>
      </div>
      {!list && <p className="muted small">Loading…</p>}
      {list?.error && <p className="small" style={{ color: "#b91c1c" }}>{list.error}</p>}
      {Array.isArray(list) && !rows.length && <p className="muted small">Nothing waiting for a manifest here.</p>}
      {rows.length > 0 && (
        <>
          <div style={{ maxHeight: 320, overflow: "auto", marginTop: 8 }}>
            <table className="table">
              <thead>
                <tr>
                  <th>
                    <input
                      type="checkbox"
                      checked={allPicked}
                      onChange={() => setPicked(allPicked ? new Set() : new Set(rows.map((r) => r.awb)))}
                      title="Select all shown"
                    />
                  </th>
                  <th>AWB</th>
                  <th>Order</th>
                  <th>Marketplace</th>
                  <th>Courier</th>
                  <th>Booked / scanned</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.awb} onClick={() => toggle(r.awb)} style={{ cursor: "pointer" }}>
                    <td>
                      <input type="checkbox" checked={picked.has(r.awb)} readOnly />
                    </td>
                    <td>
                      <strong>{r.awb}</strong>
                    </td>
                    <td>
                      {r.orderName || "—"}
                      {r.box ? <span className="muted small"> box {r.box}</span> : null}
                    </td>
                    <td>{r.channel}</td>
                    <td>{r.courier || "—"}</td>
                    <td className="small">
                      {fmt(r.at)}
                      {r.scanned ? " ✓" : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button
            className="btn btn-primary"
            style={{ marginTop: 8 }}
            disabled={!rows.some((r) => picked.has(r.awb))}
            onClick={() => {
              onAdd(rows.filter((r) => picked.has(r.awb)));
              setPicked(new Set());
            }}
          >
            Add {rows.filter((r) => picked.has(r.awb)).length || ""} selected
          </button>
          <span className="muted small" style={{ marginLeft: 8 }}>
            ✓ = AWB scanned at handover
          </span>
        </>
      )}
    </div>
  );
}

function ManifestHistory({ version, canDelete }) {
  const [q, setQ] = useState("");
  const [from, setFrom] = useState(todayIst());
  const [to, setTo] = useState(todayIst());
  const [list, setList] = useState(null);
  const [open, setOpen] = useState(null);
  const load = () =>
    api
      .get("/shopify/manifests", { params: q.trim() ? { q: q.trim() } : { from, to } })
      .then((r) => setList(r.data))
      .catch((e) => setList({ error: errMsg(e) }));
  useEffect(() => {
    const t = setTimeout(load, 300);
    return () => clearTimeout(t);
  }, [q, from, to, version]); // eslint-disable-line react-hooks/exhaustive-deps
  const del = async (m) => {
    if (!window.confirm(`Delete manifest ${m.number}? Its parcels can then go on another manifest.`)) return;
    try {
      await api.delete(`/shopify/manifests/${m._id}`);
      toast(`Manifest ${m.number} deleted`);
      load();
    } catch (e) {
      toast(errMsg(e), "error");
    }
  };
  return (
    <div className="card" style={{ padding: 16 }}>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 10 }}>
        <h3 style={{ margin: 0, marginRight: "auto" }}>Manifests</h3>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find AWB / order / MF no." style={{ width: 190 }} />
        {!q.trim() && (
          <>
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            <span className="muted">to</span>
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </>
        )}
      </div>
      {!list && <p className="muted small">Loading…</p>}
      {list?.error && <p className="small" style={{ color: "#b91c1c" }}>{list.error}</p>}
      {Array.isArray(list) && !list.length && <p className="muted small">No manifests {q.trim() ? "match" : "in these dates"}.</p>}
      {Array.isArray(list) && list.length > 0 && (
        <div style={{ overflowX: "auto" }}>
          <table className="table">
            <thead>
              <tr>
                <th>Manifest</th>
                <th>Date &amp; time</th>
                <th>Courier</th>
                <th>Marketplace</th>
                <th>Parcels</th>
                <th>By</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.map((m) => (
                <FragmentRow key={m._id} m={m} open={open === m._id} onToggle={() => setOpen(open === m._id ? null : m._id)} onDelete={canDelete ? () => del(m) : null} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function FragmentRow({ m, open, onToggle, onDelete }) {
  return (
    <>
      <tr>
        <td>
          <button type="button" onClick={onToggle} title="Show the parcels" style={{ background: "none", border: 0, padding: 0, color: "var(--brand, #4f46e5)", cursor: "pointer" }}>
            <strong>{m.number}</strong>
          </button>
        </td>
        <td className="small">{fmt(m.createdAt)}</td>
        <td>{m.courier || "—"}</td>
        <td>{m.channel || "—"}</td>
        <td>{m.count}</td>
        <td className="small">{m.createdByName}</td>
        <td style={{ whiteSpace: "nowrap" }}>
          <button className="btn btn-sm" onClick={() => openManifest(m, "A5")} title="Open the A5 manifest to print">
            Print A5
          </button>{" "}
          <button className="btn btn-sm" onClick={() => openManifest(m, "A5", true)} title="Download the A5 PDF">
            PDF
          </button>{" "}
          <button className="btn btn-sm btn-ghost" onClick={() => openManifest(m, "A4")}>
            A4
          </button>{" "}
          <button className="btn btn-sm btn-ghost" onClick={() => downloadCsv(m)}>
            CSV
          </button>
          {onDelete && (
            <>
              {" "}
              <button className="btn btn-sm btn-ghost" onClick={onDelete} title="Delete (full Shipping access only)">
                Delete
              </button>
            </>
          )}
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={7} style={{ background: "var(--surface-2, #f9fafb)" }}>
            {m.note && <div className="small muted">Note: {m.note}</div>}
            <ManifestTable rows={m.rows || []} />
          </td>
        </tr>
      )}
    </>
  );
}
