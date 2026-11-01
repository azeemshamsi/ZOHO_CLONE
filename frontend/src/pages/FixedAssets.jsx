import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import api, { errMsg } from "../lib/api";
import { money, date, isoDate } from "../lib/format";
import { PageHeader, Spinner, Empty, Field, Modal, Confirm, toast } from "../components/ui";
import Icon from "../components/Icon";

const methodLabel = (a) => (a.method === "slm" ? `Straight Line · ${a.usefulLifeYears} yrs` : a.method === "wdv" ? `Written Down Value · ${a.rate}% p.a.` : "No depreciation");

export function AssetList() {
  const [rows, setRows] = useState(null);
  const [status, setStatus] = useState("active");
  const navigate = useNavigate();
  useEffect(() => {
    setRows(null);
    api.get("/fixed-assets", { params: { status: status || undefined } }).then((r) => setRows(r.data));
  }, [status]);
  const tot = (k) => (rows || []).reduce((s, a) => s + (a.status === "disposed" ? 0 : a[k]), 0);
  return (
    <>
      <PageHeader title="Fixed Assets">
        <select className="select-inline" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="active">Active Assets</option>
          <option value="disposed">Disposed Assets</option>
          <option value="">All Assets</option>
        </select>
        <Link to="/fixed-assets/new" className="btn btn-primary">
          <Icon name="plus" size={16} /> New Asset
        </Link>
      </PageHeader>
      {!rows ? (
        <Spinner />
      ) : !rows.length ? (
        <Empty
          icon="box"
          title="No fixed assets yet"
          text="Record furniture, computers, vehicles and machinery. OrdexaGo works out the depreciation each month and posts it to your books."
          action={
            <Link to="/fixed-assets/new" className="btn btn-primary">
              New Asset
            </Link>
          }
        />
      ) : (
        <div className="card flush">
          <table className="table table-click">
            <thead>
              <tr>
                <th>Asset#</th>
                <th>Name</th>
                <th>Type</th>
                <th>Purchased</th>
                <th>Depreciation</th>
                <th className="num">Cost</th>
                <th className="num">Accumulated Dep.</th>
                <th className="num">Book Value</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a._id} onClick={() => navigate(`/fixed-assets/${a._id}`)}>
                  <td className="link">{a.number}</td>
                  <td className="strong">
                    {a.name}
                    {a.status === "disposed" && <span className="status status-void" style={{ marginLeft: 8 }}>Disposed</span>}
                  </td>
                  <td>{a.assetType}</td>
                  <td>{date(a.acquisitionDate)}</td>
                  <td className="muted small">{methodLabel(a)}</td>
                  <td className="num">{money(a.cost)}</td>
                  <td className="num">{money(a.accumulated)}</td>
                  <td className="num strong">{money(a.bookValue)}</td>
                </tr>
              ))}
              {status !== "disposed" && (
                <tr className="row-total">
                  <td colSpan={5}>Total (active)</td>
                  <td className="num">{money(tot("cost"))}</td>
                  <td className="num">{money(tot("accumulated"))}</td>
                  <td className="num">{money(tot("bookValue"))}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

export function AssetForm() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [types, setTypes] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [form, setForm] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.get("/fixed-assets/types").then((r) => setTypes(r.data));
    api.get("/accounts").then((r) => setAccounts(r.data));
    if (id)
      api.get(`/fixed-assets/${id}`).then(({ data: a }) =>
        setForm({ ...a, acquisitionDate: isoDate(a.acquisitionDate), depreciationStart: a.depreciationStart ? isoDate(a.depreciationStart) : "" })
      );
    else
      setForm({ name: "", assetType: "Computers & IT Equipment", account: "fixed_assets", serialNumber: "", location: "", description: "", acquisitionDate: isoDate(), cost: "", paidFrom: "bank", vendor: "", salvageValue: "", method: "wdv", usefulLifeYears: 5, rate: 40, depreciationStart: "" });
  }, [id]);
  if (!form) return <Spinner />;
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const assetAccounts = accounts.filter((a) => a.group === "Fixed Asset" && a.code !== "acc_depreciation");
  const banks = accounts.filter((a) => ["Cash", "Bank"].includes(a.group));
  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const body = {
        name: form.name, assetType: form.assetType, account: form.account, serialNumber: form.serialNumber, location: form.location, description: form.description,
        acquisitionDate: form.acquisitionDate, cost: Number(form.cost), paidFrom: form.paidFrom, vendor: form.vendor, salvageValue: Number(form.salvageValue || 0),
        method: form.method, usefulLifeYears: Number(form.usefulLifeYears || 0), rate: Number(form.rate || 0), depreciationStart: form.depreciationStart || null,
      };
      const { data } = id ? await api.put(`/fixed-assets/${id}`, body) : await api.post("/fixed-assets", body);
      toast(id ? "Asset updated" : "Asset added");
      navigate(`/fixed-assets/${data._id}`);
    } catch (err) {
      setError(errMsg(err));
      setBusy(false);
    }
  };
  return (
    <>
      <PageHeader title={id ? `Edit ${form.number}` : "New Fixed Asset"} back={id ? `/fixed-assets/${id}` : "/fixed-assets"} />
      <form className="card form" onSubmit={save}>
        <div className="form-grid">
          <div className="row-2">
            <Field label="Asset Name" required>
              <input required value={form.name} onChange={set("name")} autoFocus placeholder="e.g. Dell laptop" />
            </Field>
            <Field label="Asset Type">
              <select value={form.assetType} onChange={set("assetType")}>
                {types.map((t) => (
                  <option key={t}>{t}</option>
                ))}
              </select>
            </Field>
          </div>
          <div className="row-3">
            <Field label="Asset Account" hint="Add more in Chart of Accounts (type Fixed Asset)">
              <select value={form.account} onChange={set("account")}>
                {assetAccounts.map((a) => (
                  <option key={a.code} value={a.code}>
                    {a.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Serial Number">
              <input value={form.serialNumber} onChange={set("serialNumber")} />
            </Field>
            <Field label="Location">
              <input value={form.location} onChange={set("location")} />
            </Field>
          </div>
        </div>
        <h4 className="section-title">Purchase</h4>
        <div className="form-grid">
          <div className="row-3">
            <Field label="Purchase Date" required>
              <input type="date" required value={form.acquisitionDate} onChange={set("acquisitionDate")} />
            </Field>
            <Field label="Cost (₹)" required hint="Excluding GST you can claim as input credit">
              <input type="number" step="0.01" min="0.01" required value={form.cost} onChange={set("cost")} />
            </Field>
            <Field label="Vendor">
              <input value={form.vendor} onChange={set("vendor")} />
            </Field>
          </div>
          <Field label="Paid From" hint="How the purchase is recorded in your books">
            <select value={form.paidFrom} onChange={set("paidFrom")}>
              {banks.map((a) => (
                <option key={a.code} value={a.code}>
                  Paid from {a.name}
                </option>
              ))}
              <option value="opening_equity">Already owned (opening balance)</option>
              <option value="">Already recorded elsewhere (e.g. a journal) — don't post the purchase</option>
            </select>
          </Field>
        </div>
        <h4 className="section-title">Depreciation</h4>
        <div className="form-grid">
          <div className="radio-row">
            {[
              ["wdv", "Written Down Value (Income Tax)"],
              ["slm", "Straight Line (Companies Act)"],
              ["none", "Don't depreciate (e.g. land)"],
            ].map(([k, l]) => (
              <label key={k} className="radio">
                <input type="radio" checked={form.method === k} onChange={() => setForm({ ...form, method: k })} /> {l}
              </label>
            ))}
          </div>
          {form.method !== "none" && (
            <div className="row-3">
              {form.method === "slm" ? (
                <Field label="Useful Life (years)" required>
                  <input type="number" step="0.5" min="0.5" value={form.usefulLifeYears} onChange={set("usefulLifeYears")} />
                </Field>
              ) : (
                <Field label="Rate (% per year)" required hint="e.g. computers 40%, furniture 10%, vehicles 15%, machinery 15%">
                  <input type="number" step="0.01" min="0.01" value={form.rate} onChange={set("rate")} />
                </Field>
              )}
              <Field label="Salvage Value (₹)" hint="Book value is never depreciated below this">
                <input type="number" step="0.01" min="0" value={form.salvageValue} onChange={set("salvageValue")} />
              </Field>
              <Field label="Depreciation Starts" hint="Defaults to the purchase date">
                <input type="date" value={form.depreciationStart} onChange={set("depreciationStart")} />
              </Field>
            </div>
          )}
          <Field label="Description">
            <textarea rows={2} value={form.description} onChange={set("description")} />
          </Field>
        </div>
        {error && <div className="alert alert-error">{error}</div>}
        <div className="form-footer">
          <button className="btn btn-primary" disabled={busy}>
            Save
          </button>
          <button type="button" className="btn" onClick={() => navigate(-1)}>
            Cancel
          </button>
        </div>
      </form>
    </>
  );
}

export function AssetView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [a, setA] = useState(null);
  const [dispose, setDispose] = useState(false);
  const [confirm, setConfirm] = useState(null);
  const [showAll, setShowAll] = useState(false);
  const load = () => api.get(`/fixed-assets/${id}`).then((r) => setA(r.data));
  useEffect(() => {
    load();
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!a) return <Spinner />;
  const stat = (l, v, cls = "") => (
    <div className="stat">
      <div className="muted small">{l}</div>
      <div className={`stat-value ${cls}`}>{v}</div>
    </div>
  );
  const act = async (fn, msg, after) => {
    try {
      await fn();
      toast(msg);
      setConfirm(null);
      after ? after() : load();
    } catch (e) {
      setConfirm(null);
      toast(errMsg(e), "error");
    }
  };
  // Yearly view of the schedule (financial years).
  const years = {};
  for (const r of a.schedule) {
    const d = new Date(r.date);
    const fy = d.getUTCMonth() >= 3 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
    years[fy] = years[fy] || { fy, amount: 0, closing: 0, posted: true };
    years[fy].amount += r.amount;
    years[fy].closing = r.bookValue;
    years[fy].posted = years[fy].posted && r.posted;
  }
  const yearRows = Object.values(years);
  return (
    <>
      <PageHeader title={`${a.name}`} subtitle={`${a.number} · ${a.assetType} · ${methodLabel(a)}`} back="/fixed-assets">
        {a.status === "active" ? (
          <>
            <Link to={`/fixed-assets/${id}/edit`} className="btn">
              Edit
            </Link>
            <button className="btn btn-primary" onClick={() => setDispose(true)}>
              Sell / Write Off
            </button>
          </>
        ) : (
          <button className="btn" onClick={() => setConfirm("undispose")}>
            Undo Disposal
          </button>
        )}
        <button className="icon-btn" title="Delete" onClick={() => setConfirm("delete")}>
          <Icon name="trash" />
        </button>
      </PageHeader>
      <div className="card">
        <div className="stats-row">
          {stat("Cost", money(a.cost))}
          {stat("Purchased", date(a.acquisitionDate))}
          {stat("Accumulated Depreciation", money(a.accumulated))}
          {stat("Book Value Today", money(a.bookValue))}
          {stat("Salvage Value", money(a.salvageValue))}
          {a.status === "disposed" && stat(a.disposal.kind === "sold" ? `Sold ${date(a.disposal.date)}` : `Written off ${date(a.disposal.date)}`, a.disposal.kind === "sold" ? money(a.disposal.amount) : "—")}
          {a.status === "disposed" && stat(a.gainLoss >= 0 ? "Gain on disposal" : "Loss on disposal", money(Math.abs(a.gainLoss)), a.gainLoss >= 0 ? "text-good" : "text-danger")}
        </div>
        {(a.serialNumber || a.location || a.vendor) && <p className="muted small">{[a.serialNumber && `Serial ${a.serialNumber}`, a.location && `Location: ${a.location}`, a.vendor && `Vendor: ${a.vendor}`].filter(Boolean).join(" · ")}</p>}
      </div>
      <div className="card flush">
        <div className="pad-row">
          <h3 className="card-title pad">Depreciation Schedule</h3>
          <label className="check small">
            <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> Monthly detail
          </label>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>{showAll ? "Month" : "Financial Year"}</th>
              <th className="num">Depreciation</th>
              {showAll && <th className="num">Accumulated</th>}
              <th className="num">Book Value at End</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {showAll
              ? a.schedule.map((r, i) => (
                  <tr key={i} className={r.posted ? "" : "muted"}>
                    <td>{date(r.date)}</td>
                    <td className="num">{money(r.amount, r.currency)}</td>
                    <td className="num">{money(r.accumulated)}</td>
                    <td className="num">{money(r.bookValue)}</td>
                    <td>{r.posted ? "Posted" : "Projected"}</td>
                  </tr>
                ))
              : yearRows.map((r) => (
                  <tr key={r.fy} className={r.posted ? "" : ""}>
                    <td>
                      FY {r.fy}-{String(r.fy + 1).slice(2)}
                    </td>
                    <td className="num">{money(r.amount, r.currency)}</td>
                    <td className="num">{money(r.closing)}</td>
                    <td>{r.posted ? "Posted" : "Projected"}</td>
                  </tr>
                ))}
            {!a.schedule.length && (
              <tr>
                <td colSpan={5} className="muted center">
                  No depreciation for this asset.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {dispose && <DisposeModal asset={a} onClose={() => setDispose(false)} onDone={() => (setDispose(false), load())} />}
      <Confirm
        open={!!confirm}
        title={confirm === "delete" ? "Delete asset?" : "Undo disposal?"}
        text={confirm === "delete" ? "Its purchase, depreciation and disposal entries are removed from the books." : "The asset becomes active again and depreciation resumes."}
        confirmLabel={confirm === "delete" ? "Delete" : "Undo"}
        onConfirm={() =>
          confirm === "delete"
            ? act(() => api.delete(`/fixed-assets/${id}`), "Asset deleted", () => navigate("/fixed-assets"))
            : act(() => api.delete(`/fixed-assets/${id}/dispose`), "Disposal undone")
        }
        onCancel={() => setConfirm(null)}
      />
    </>
  );
}

function DisposeModal({ asset, onClose, onDone }) {
  const [banks, setBanks] = useState([]);
  const [f, setF] = useState({ kind: "sold", date: isoDate(), amount: "", account: "bank", notes: "" });
  const [error, setError] = useState("");
  useEffect(() => {
    api.get("/accounts").then((r) => setBanks(r.data.filter((a) => ["Cash", "Bank"].includes(a.group))));
  }, []);
  const save = async () => {
    try {
      await api.post(`/fixed-assets/${asset._id}/dispose`, { ...f, amount: Number(f.amount || 0) });
      toast(f.kind === "sold" ? "Asset sold" : "Asset written off");
      onDone();
    } catch (e) {
      setError(errMsg(e));
    }
  };
  return (
    <Modal
      open
      title={`Dispose ${asset.name}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-primary" onClick={save}>
            Save
          </button>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
        </>
      }
    >
      <div className="form-grid">
        <div className="radio-row">
          <label className="radio">
            <input type="radio" checked={f.kind === "sold"} onChange={() => setF({ ...f, kind: "sold" })} /> Sold
          </label>
          <label className="radio">
            <input type="radio" checked={f.kind === "written_off"} onChange={() => setF({ ...f, kind: "written_off" })} /> Written off / scrapped
          </label>
        </div>
        <Field label="Date" required>
          <input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} />
        </Field>
        {f.kind === "sold" && (
          <div className="row-2">
            <Field label="Sale Amount (₹)" required hint="Excluding GST">
              <input type="number" step="0.01" min="0" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} />
            </Field>
            <Field label="Received Into">
              <select value={f.account} onChange={(e) => setF({ ...f, account: e.target.value })}>
                {banks.map((b) => (
                  <option key={b.code} value={b.code}>
                    {b.name}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        )}
        <Field label="Notes">
          <input value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
        </Field>
        <p className="muted small">Depreciation is charged up to this date. The difference between the sale amount and the book value is posted as a gain or loss.</p>
        {error && <div className="alert alert-error">{error}</div>}
      </div>
    </Modal>
  );
}
