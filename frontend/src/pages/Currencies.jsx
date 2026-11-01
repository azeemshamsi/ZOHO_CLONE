import { useEffect, useState } from "react";
import api, { errMsg } from "../lib/api";
import { date } from "../lib/format";
import { PageHeader, Spinner, Field, Modal, Confirm, toast } from "../components/ui";
import Icon from "../components/Icon";

export function Currencies() {
  const [rows, setRows] = useState(null);
  const [common, setCommon] = useState([]);
  const [modal, setModal] = useState(null);
  const [del, setDel] = useState(null);
  const load = () => api.get("/currencies").then((r) => setRows(r.data));
  useEffect(() => {
    load();
    api.get("/currencies/common").then((r) => setCommon(r.data));
  }, []);
  if (!rows) return <Spinner />;
  return (
    <>
      <PageHeader title="Currencies" subtitle="Your base currency is INR. Add the currencies your foreign customers and vendors use.">
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
                <td className="muted">{c.rates?.length ? date(c.rates[c.rates.length - 1].date) : ""}</td>
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
