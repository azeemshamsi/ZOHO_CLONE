import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import api, { errMsg } from "../lib/api";
import { useAuth } from "../lib/auth";
import { money, date, isoDate } from "../lib/format";
import { PageHeader, Spinner, toast } from "../components/ui";
import { downloadJson } from "../components/GstPanel";

const docUrl = (r) => (r.kind === "creditNote" ? `/credit-notes/${r.id}` : `/invoices/${r.id}`);

export function GstCompliance({ tab: initial = "einvoice" }) {
  const { organization, setOrganization } = useAuth();
  const [tab, setTab] = useState(initial);
  const [status, setStatus] = useState("pending");
  const [rows, setRows] = useState(null);
  const [picked, setPicked] = useState(new Set());
  const einv = organization?.einvoicing || {};
  const eway = organization?.ewayBills || {};
  const on = tab === "einvoice" ? einv.enabled : eway.enabled;
  const load = () => {
    setRows(null);
    setPicked(new Set());
    if (!on) return setRows([]);
    api.get(tab === "einvoice" ? "/gst/einvoices" : "/gst/eway-bills", { params: { status } }).then((r) => setRows(r.data));
  };
  useEffect(() => {
    setTab(initial);
  }, [initial]);
  useEffect(load, [tab, status, on]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = async (body) => {
    try {
      const { data } = await api.put("/gst/settings", body);
      setOrganization(data);
      toast("Saved");
    } catch (e) {
      toast(errMsg(e), "error");
    }
  };
  const ok = (rows || []).filter((r) => !r.errors?.length);
  const bulk = async () => {
    try {
      const chosen = rows.filter((r) => picked.has(String(r.id)));
      if (tab === "einvoice") {
        const { data } = await api.post("/gst/einvoice/bulk-json", { docs: chosen.map((r) => ({ kind: r.kind, id: r.id })) });
        if (data.json.length) downloadJson(data.json, `einvoices-${isoDate()}.json`);
        toast(`${data.json.length} e-invoice(s) in the file${data.skipped.length ? `, ${data.skipped.length} skipped` : ""}`);
      } else {
        const { data } = await api.post("/gst/eway/bulk-json", { ids: chosen.map((r) => r.id) });
        if (data.json.billLists.length) downloadJson(data.json, `ewaybills-${isoDate()}.json`);
        toast(`${data.json.billLists.length} e-way bill(s) in the file${data.skipped.length ? `, ${data.skipped.length} skipped` : ""}`);
      }
    } catch (e) {
      toast(errMsg(e), "error");
    }
  };
  return (
    <>
      <PageHeader title={tab === "einvoice" ? "e-Invoices" : "e-Way Bills"} subtitle={tab === "einvoice" ? "IRN for B2B, SEZ and export invoices and credit notes" : "For goods worth ₹50,000 or more per consignment"}>
        <div className="seg">
          <Link className={tab === "einvoice" ? "on" : ""} to="/e-invoices">
            e-Invoices
          </Link>
          <Link className={tab === "eway" ? "on" : ""} to="/e-way-bills">
            e-Way Bills
          </Link>
        </div>
      </PageHeader>
      <div className="card form">
        {tab === "einvoice" ? (
          <div className="inline-add" style={{ flexWrap: "wrap", gap: 14 }}>
            <label className="check">
              <input type="checkbox" checked={!!einv.enabled} onChange={(e) => save({ einvoicing: { enabled: e.target.checked, fromDate: einv.fromDate || null } })} /> e-Invoicing applies to my business (turnover above the notified limit, currently ₹5 crore)
            </label>
            {einv.enabled && (
              <label className="check">
                From
                <input type="date" style={{ width: 160 }} value={einv.fromDate ? isoDate(einv.fromDate) : ""} onChange={(e) => save({ einvoicing: { enabled: true, fromDate: e.target.value || null } })} />
              </label>
            )}
          </div>
        ) : (
          <div className="inline-add" style={{ flexWrap: "wrap", gap: 14 }}>
            <label className="check">
              <input type="checkbox" checked={!!eway.enabled} onChange={(e) => save({ ewayBills: { enabled: e.target.checked, threshold: eway.threshold ?? 50000 } })} /> Track e-way bills on invoices for goods
            </label>
            {eway.enabled && (
              <label className="check">
                Required from ₹
                <input type="number" style={{ width: 120 }} value={eway.threshold ?? 50000} onChange={(e) => save({ ewayBills: { enabled: true, threshold: Number(e.target.value) || 0 } })} />
              </label>
            )}
          </div>
        )}
        <p className="muted small" style={{ marginBottom: 0 }}>
          {tab === "einvoice"
            ? "How it works: select invoices → Download JSON → on einvoice1.gst.gov.in use e-Invoice → Bulk Upload → it returns the IRN, Ack No and signed QR → open each invoice → Record IRN (or upload the response file). The QR code then prints on the invoice and PDF."
            : "How it works: add transport details on the invoice → select invoices → Download JSON → on ewaybillgst.gov.in use e-Waybill → Generate Bulk → open the invoice → Record EWB No. The e-way bill number then prints on the invoice and PDF."}
        </p>
      </div>
      {on && (
        <div className="card flush">
          <div className="pad-row" style={{ padding: "10px 16px" }}>
            <div className="seg">
              {[
                ["pending", "Pending"],
                ["generated", "Generated"],
                ["cancelled", "Cancelled"],
              ].map(([k, l]) => (
                <button key={k} className={status === k ? "on" : ""} onClick={() => setStatus(k)}>
                  {l}
                </button>
              ))}
            </div>
            {status === "pending" && (
              <button className="btn btn-primary btn-sm" disabled={!picked.size} onClick={bulk}>
                Download JSON ({picked.size})
              </button>
            )}
          </div>
          {!rows ? (
            <Spinner />
          ) : (
            <table className="table">
              <thead>
                <tr>
                  {status === "pending" && (
                    <th>
                      <input type="checkbox" checked={ok.length > 0 && picked.size === ok.length} onChange={(e) => setPicked(new Set(e.target.checked ? ok.map((r) => String(r.id)) : []))} />
                    </th>
                  )}
                  <th>Date</th>
                  <th>Document</th>
                  <th>Customer</th>
                  <th className="num">Value</th>
                  <th>{status === "pending" ? "Ready?" : tab === "einvoice" ? "IRN / Ack" : "EWB No"}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={String(r.id)}>
                    {status === "pending" && (
                      <td>
                        <input
                          type="checkbox"
                          disabled={!!r.errors?.length}
                          checked={picked.has(String(r.id))}
                          onChange={() => {
                            const n = new Set(picked);
                            n.has(String(r.id)) ? n.delete(String(r.id)) : n.add(String(r.id));
                            setPicked(n);
                          }}
                        />
                      </td>
                    )}
                    <td className="nowrap">{date(r.date)}</td>
                    <td>
                      <Link to={docUrl(r)}>
                        {r.kind === "creditNote" ? "Credit Note " : ""}
                        {r.number}
                      </Link>
                    </td>
                    <td>{r.customerName}</td>
                    <td className="num">{tab === "einvoice" ? money(r.total, r.currency) : money(r.value)}</td>
                    <td className="small">
                      {status === "pending" ? (
                        r.errors?.length ? (
                          <span className="text-danger" title={r.errors.join("\n")}>
                            {r.errors.length} problem{r.errors.length > 1 ? "s" : ""}: {r.errors[0]}
                          </span>
                        ) : (
                          <span className="text-good">Ready{tab === "eway" && !r.required ? " (optional)" : ""}</span>
                        )
                      ) : tab === "einvoice" ? (
                        <span className="mono">
                          {r.einvoice.irn?.slice(0, 16)}… · {r.einvoice.ackNo}
                        </span>
                      ) : (
                        <>
                          {r.eway.ewbNo} {r.eway.validUpto && `· valid till ${date(r.eway.validUpto)}`}
                        </>
                      )}
                    </td>
                  </tr>
                ))}
                {!rows.length && (
                  <tr>
                    <td colSpan={6} className="muted center">
                      Nothing here.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          )}
        </div>
      )}
    </>
  );
}
