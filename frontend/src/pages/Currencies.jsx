import { useEffect, useState } from "react";
import api, { errMsg } from "../lib/api";
import { date, money, isoDate } from "../lib/format";
import { useAuth } from "../lib/auth";
import { PageHeader, Spinner, Field, Modal, Confirm, toast } from "../components/ui";
import Icon from "../components/Icon";

export function Currencies() {
  const [rows, setRows] = useState(null);
  const [common, setCommon] = useState([]);
  const [modal, setModal] = useState(null);
  const [del, setDel] = useState(null);
  const [adjs, setAdjs] = useState([]);
  const [adjOpen, setAdjOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const { organization, setOrganization } = useAuth();
  const load = () => {
    api.get("/currencies/adjustments").then((r) => setAdjs(r.data));
    return api.get("/currencies").then((r) => setRows(r.data));
  };
  const refresh = async () => {
    setBusy(true);
    try {
      const { data } = await api.post("/currencies/refresh");
      toast(data.updated.length ? `Updated ${data.updated.map((u) => `${u.code} ₹${u.rate}`).join(", ")}` : "No rates found for your currencies");
      load();
    } catch (e) {
      toast(errMsg(e), "error");
    }
    setBusy(false);
  };
  const setAuto = async (v) => {
    const { data } = await api.put("/currencies/settings", { autoUpdate: v });
    setOrganization(data);
    toast(v ? "Rates will update every day" : "Automatic updates off");
  };
  useEffect(() => {
    load();
    api.get("/currencies/common").then((r) => setCommon(r.data));
  }, []);
  if (!rows) return <Spinner />;
  return (
    <>
      <PageHeader title="Currencies" subtitle="Your base currency is INR. Add the currencies your foreign customers and vendors use.">
        {rows.length > 0 && (
          <>
            <label className="check small">
              <input type="checkbox" checked={!!organization?.fxAutoUpdate} onChange={(e) => setAuto(e.target.checked)} /> Update rates daily
            </label>
            <button className="btn" disabled={busy} onClick={refresh}>
              {busy ? "Fetching…" : "Fetch Latest Rates"}
            </button>
          </>
        )}
        <button className="btn btn-primary" onClick={() => setModal({})}>
          <Icon name="plus" size={16} /> New Currency
        </button>
      </PageHeader>
      <div className="card flush">
        <table className="table">
          <thead>
            <tr>
              <th>Currency</th>
              <th>Symbol</th>
              <th className="num">Exchange Rate (₹ per unit)</th>
              <th>Last Updated</th>
              <th />
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="strong">
                INR - Indian Rupee <span className="status status-sent">Base</span>
              </td>
              <td>₹</td>
              <td className="num">1</td>
              <td />
              <td />
            </tr>
            {rows.map((c) => (
              <tr key={c._id}>
                <td className="strong">
                  {c.code} - {c.name}
                </td>
                <td>{c.symbol}</td>
                <td className="num">{c.rate}</td>
                <td className="muted">
                  {c.rateUpdatedAt ? date(c.rateUpdatedAt) : c.rates?.length ? date(c.rates[c.rates.length - 1].date) : ""}
                  <div className="small">{c.rateSource && c.rateSource !== "manual" ? `from ${c.rateSource}` : "entered by hand"}</div>
                </td>
                <td className="num nowrap">
                  <button className="btn btn-sm" onClick={() => setModal(c)}>
                    Update Rate
                  </button>{" "}
                  <button className="icon-btn" onClick={() => setDel(c)}>
                    <Icon name="trash" size={15} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted small" style={{ padding: "0 16px 14px" }}>
          Then set the currency on a customer or vendor. Their invoices, bills and payments are in that currency, with the rate shown on each document (you can change it per document). Reports and your books are always in ₹; differences between the invoice rate and the payment rate are posted to "Exchange Loss / (Gain)".
        </p>
      </div>
      {rows.length > 0 && (
        <div className="card flush">
          <div className="pad-row">
            <h3 className="card-title pad">Exchange Rate Adjustments</h3>
            <button className="btn btn-sm" onClick={() => setAdjOpen(true)}>
              <Icon name="plus" size={14} /> Revalue
            </button>
          </div>
          <table className="table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Currency</th>
                <th className="num">Rate</th>
                <th className="num">Documents</th>
                <th className="num">Unrealised Gain / (Loss)</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {adjs.map((a) => (
                <tr key={a._id}>
                  <td>{date(a.date)}</td>
                  <td>{a.currency}</td>
                  <td className="num">{a.rate}</td>
                  <td className="num" title={a.lines.map((l) => l.number).join(", ")}>{a.lines.length}</td>
                  <td className={`num ${a.total >= 0 ? "text-good" : "text-danger"}`}>{money(a.total)}</td>
                  <td className="num">
                    <button
                      className="icon-btn"
                      onClick={async () => {
                        await api.delete(`/currencies/adjustments/${a._id}`);
                        toast("Adjustment deleted");
                        load();
                      }}
                    >
                      <Icon name="trash" size={15} />
                    </button>
                  </td>
                </tr>
              ))}
              {!adjs.length && (
                <tr>
                  <td colSpan={6} className="muted center">
                    At year-end (31 March), revalue unpaid foreign invoices and bills at the closing rate so the balance sheet shows them at today's value.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      {adjOpen && <AdjustModal currencies={rows} onClose={() => setAdjOpen(false)} onSaved={() => (setAdjOpen(false), load())} />}
      {modal && <CurrencyModal cur={modal._id ? modal : null} common={common.filter((c) => !rows.some((r) => r.code === c.code))} onClose={() => setModal(null)} onSaved={() => (setModal(null), load())} />}
      <Confirm
        open={!!del}
        title={`Remove ${del?.code}?`}
        text="Only possible if no customer or vendor uses it."
        confirmLabel="Remove"
        onConfirm={async () => {
          try {
            await api.delete(`/currencies/${del._id}`);
            toast("Currency removed");
            load();
          } catch (e) {
            toast(errMsg(e), "error");
          }
          setDel(null);
        }}
        onCancel={() => setDel(null)}
      />
    </>
  );
}

function CurrencyModal({ cur, common, onClose, onSaved }) {
  const [f, setF] = useState(cur ? { code: cur.code, symbol: cur.symbol, name: cur.name, rate: cur.rate } : { code: common[0]?.code || "", symbol: common[0]?.symbol || "", name: common[0]?.name || "", rate: "" });
  const [error, setError] = useState("");
  const save = async () => {
    try {
      const body = { ...f, rate: Number(f.rate) };
      if (cur) await api.put(`/currencies/${cur._id}`, body);
      else await api.post("/currencies", body);
      toast("Saved");
      onSaved();
    } catch (e) {
      setError(errMsg(e));
    }
  };
  return (
    <Modal
      open
      title={cur ? `Update ${cur.code} rate` : "New Currency"}
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
        {!cur && (
          <Field label="Currency">
            <select
              value={f.code}
              onChange={(e) => {
                const c = common.find((x) => x.code === e.target.value);
                setF({ ...f, code: c.code, symbol: c.symbol, name: c.name });
              }}
            >
              {common.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.code} - {c.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label={`Exchange Rate (1 ${f.code} = ₹)`} required hint="Used as the default on new documents; you can change it on each one.">
          <input type="number" step="0.0001" min="0" value={f.rate} onChange={(e) => setF({ ...f, rate: e.target.value })} autoFocus />
        </Field>
        {error && <div className="alert alert-error">{error}</div>}
      </div>
    </Modal>
  );
}

function AdjustModal({ currencies, onClose, onSaved }) {
  const y = new Date().getMonth() >= 3 ? new Date().getFullYear() : new Date().getFullYear() - 1;
  const [f, setF] = useState({ currency: currencies[0].code, date: `${y}-03-31` < isoDate() ? `${y}-03-31` : isoDate(), rate: currencies[0].rate });
  const [prev, setPrev] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    setPrev(null);
    if (!(Number(f.rate) > 0) || !f.date) return;
    let current = true; // ignore answers to older requests
    api
      .get("/currencies/adjustments/preview", { params: f })
      .then((r) => current && setPrev(r.data))
      .catch((e) => current && setError(errMsg(e)));
    return () => {
      current = false;
    };
  }, [f]);
  const save = async () => {
    try {
      await api.post("/currencies/adjustments", { ...f, rate: Number(f.rate) });
      toast("Revaluation posted");
      onSaved();
    } catch (e) {
      setError(errMsg(e));
    }
  };
  return (
    <Modal
      open
      wide
      title="Revalue Foreign Currency Balances"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-primary" disabled={!prev?.lines.length} onClick={save}>
            Post Adjustment
          </button>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
        </>
      }
    >
      <div className="form-grid">
        <div className="row-3">
          <Field label="Currency">
            <select value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value, rate: currencies.find((c) => c.code === e.target.value).rate })}>
              {currencies.map((c) => (
                <option key={c.code}>{c.code}</option>
              ))}
            </select>
          </Field>
          <Field label="As of Date">
            <input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} />
          </Field>
          <Field label={`Closing Rate (1 ${f.currency} = ₹)`}>
            <input type="number" step="0.0001" value={f.rate} onChange={(e) => setF({ ...f, rate: e.target.value })} />
          </Field>
        </div>
        {!prev ? (
          <Spinner />
        ) : !prev.lines.length ? (
          <p className="muted">No unpaid {f.currency} invoices or bills on this date.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Document</th>
                <th>Customer / Vendor</th>
                <th className="num">Unpaid ({f.currency})</th>
                <th className="num">Book Rate</th>
                <th className="num">Gain / (Loss)</th>
              </tr>
            </thead>
            <tbody>
              {prev.lines.map((l) => (
                <tr key={String(l.id)}>
                  <td>
                    {l.kind === "invoice" ? "Invoice" : "Bill"} {l.number}
                  </td>
                  <td>{l.party}</td>
                  <td className="num">{l.balance}</td>
                  <td className="num">{l.bookRate}</td>
                  <td className={`num ${l.gain >= 0 ? "text-good" : "text-danger"}`}>{money(l.gain)}</td>
                </tr>
              ))}
              <tr className="row-total">
                <td colSpan={4}>Net unrealised gain / (loss)</td>
                <td className="num">{money(prev.total)}</td>
              </tr>
            </tbody>
          </table>
        )}
        <p className="muted small">Posted to "Unrealised Exchange Loss / (Gain)" on this date and reversed the next day, so when the customer or vendor actually pays, the full difference is realised then.</p>
        {error && <div className="alert alert-error">{error}</div>}
      </div>
    </Modal>
  );
}
