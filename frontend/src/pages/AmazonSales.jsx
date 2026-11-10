import { Fragment, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import api, { errMsg } from "../lib/api";
import { money } from "../lib/format";
import {
  PageHeader,
  Spinner,
  Empty,
  Field,
  Modal,
  toast,
} from "../components/ui";
import Icon from "../components/Icon";

// Sales → Amazon: import Amazon's Merchant Tax Report (B2C / B2B) and check the month against Amazon's GSTR-1.

const readFile = (file) =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve({ name: file.name, data: r.result });
    r.onerror = () => reject(new Error(`Couldn't read ${file.name}`));
    r.readAsDataURL(file);
  });
const monthLabel = (m) =>
  m
    ? new Date(`${m}-15T00:00:00Z`).toLocaleString("en-IN", {
        month: "long",
        year: "numeric",
        timeZone: "UTC",
      })
    : "";

// The marketplaces this page imports (same posting; Amazon also has the per-invoice GSTR-1 check and B2B move).
const SOURCES = {
  amazon: {
    key: "amazon",
    api: "/amazon",
    label: "Amazon",
    title: "Amazon Sales",
    subtitle:
      "Import Amazon's Merchant Tax Report and check it against Amazon's GSTR-1 report",
    b2c: "Amazon B2C",
    ledger: "Amazon Sales",
  },
  pepperfry: {
    key: "pepperfry",
    api: "/pepperfry-sales",
    label: "Pepperfry",
    title: "Pepperfry Sales",
    subtitle:
      "Import Pepperfry's monthly GSTR-1 report and check it against Pepperfry's TCS report",
    b2c: "Pepperfry B2C",
    ledger: "Pepperfry Sales",
  },
  flipkart: {
    key: "flipkart",
    api: "/flipkart-sales",
    label: "Flipkart",
    title: "Flipkart Sales",
    subtitle:
      "Import Flipkart's monthly Sales Report and check it against Flipkart's GSTR-1 report",
    b2c: "Flipkart B2C",
    ledger: "Flipkart Sales",
  },
};

export default function AmazonSales() {
  return <MarketplaceSales S={SOURCES.amazon} />;
}
export function FlipkartSales() {
  return <MarketplaceSales S={SOURCES.flipkart} />;
}
export function PepperfrySales() {
  return <MarketplaceSales S={SOURCES.pepperfry} />;
}

function MarketplaceSales({ S }) {
  const [list, setList] = useState(null);
  const [check, setCheck] = useState(null); // { month, result }
  const [moveFor, setMoveFor] = useState(null);
  const loadMonths = () =>
    api
      .get(`${S.api}/months`)
      .then((r) => setList(r.data))
      .catch((e) => toast(errMsg(e), "error"));
  useEffect(() => {
    loadMonths();
  }, []);
  return (
    <>
      <PageHeader title={S.title} subtitle={S.subtitle} />
      <ImportBox
        S={S}
        onImported={(month, gstr1Files) => {
          loadMonths();
          if (gstr1Files?.length) runCheck(S, month, gstr1Files, setCheck);
        }}
      />
      <div className="card" style={{ marginTop: 16, overflowX: "auto" }}>
        <div className="card-head">
          <h3>Imported months</h3>
        </div>
        {!list ? (
          <Spinner />
        ) : !list.months.length ? (
          <Empty
            title="Nothing imported yet"
            text={
              S.key === "pepperfry"
                ? "Upload Pepperfry's GSTR-1 report and TCS report for a month (the zips as downloaded)."
                : S.key === "flipkart"
                  ? "Upload Flipkart's Sales Report for a month (the Excel file as downloaded)."
                  : "Upload Amazon's MTR B2C and B2B reports (the zips as downloaded are fine)."
            }
          />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Month ({S.label} report)</th>
                <th>GSTIN</th>
                <th className="num">Invoices</th>
                <th className="num">of which B2B</th>
                <th className="num">Credit notes</th>
                <th className="num">Taxable (net)</th>
                <th className="num">Value (net)</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.months.map((m) => (
                <tr key={`${m.gstin}-${m.month}`}>
                  <td className="strong">{monthLabel(m.month)}</td>
                  <td className="small">{m.gstin}</td>
                  <td className="num">{m.invoices}</td>
                  <td className="num">{m.b2b}</td>
                  <td className="num">{m.creditNotes}</td>
                  <td className="num">{money(m.taxable)}</td>
                  <td className="num">{money(m.value)}</td>
                  <td className="num">
                    <div
                      style={{
                        display: "flex",
                        gap: 6,
                        justifyContent: "flex-end",
                        flexWrap: "wrap",
                      }}
                    >
                      <CheckButton S={S} month={m.month} onResult={setCheck} />
                      {m.b2b > 0 && S.key === "amazon" && (
                        <button
                          className="btn btn-sm"
                          onClick={() => setMoveFor(m.month)}
                          title="B2B invoices recorded under the Amazon party ledger → their buyers"
                        >
                          Move B2B to buyers
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {check &&
        (S.key !== "amazon" ? (
          <FlipkartCheck S={S} r={check} onClose={() => setCheck(null)} />
        ) : (
          <CheckResult r={check} onClose={() => setCheck(null)} />
        ))}
      {moveFor && <MoveB2b month={moveFor} onClose={() => setMoveFor(null)} />}
    </>
  );
}

async function runCheck(S, month, files, setCheck) {
  try {
    const { data } = await api.post(`${S.api}/reconcile`, { month, files });
    setCheck(data);
  } catch (e) {
    toast(errMsg(e), "error");
  }
}

// B2B documents imported under the Amazon party (Amazon_SRE) → the buyer named on each, by GSTIN.
function MoveB2b({ month, onClose }) {
  const [rows, setRows] = useState(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);
  useEffect(() => {
    api
      .get("/amazon/move-b2b", { params: { month } })
      .then((r) => setRows(r.data.rows))
      .catch((e) => (toast(errMsg(e), "error"), onClose()));
  }, [month]);
  const go = async () => {
    setBusy(true);
    try {
      const { data } = await api.post("/amazon/move-b2b", { month });
      setDone(data);
      setRows(data.rows);
      toast(
        `${data.moved} moved to their buyers${data.skipped ? `, ${data.skipped} skipped` : ""}`,
      );
    } catch (e) {
      toast(errMsg(e), "error");
    }
    setBusy(false);
  };
  const movable = (rows || []).filter((r) => !r.skip).length;
  return (
    <Modal
      open
      title={`Move B2B to buyers — ${monthLabel(month)}`}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {done ? "Close" : "Cancel"}
          </button>
          {!done && (
            <button
              className="btn btn-primary"
              disabled={busy || !movable}
              onClick={go}
            >
              {busy
                ? "Moving…"
                : `Move ${movable} document${movable === 1 ? "" : "s"}`}
            </button>
          )}
        </>
      }
    >
      {!rows ? (
        <Spinner />
      ) : !rows.length ? (
        <p>
          Every B2B document of this month is already with its buyer — nothing
          to move.
        </p>
      ) : (
        <>
          <p className="small muted" style={{ marginTop: 0 }}>
            Only the party changes (customer, name, billing address). Number,
            items, Online Sale ledger, GST, the buyer's GSTIN and Amazon's IRN
            stay as they are, so the trial balance doesn't change — the amount
            moves from the Amazon party to each buyer under Sundry Debtors.
            Documents with a payment applied are left as they are.
          </p>
          <div style={{ overflowX: "auto" }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Document</th>
                  <th>Date</th>
                  <th className="num">Amount</th>
                  <th>Now under</th>
                  <th>{done ? "Moved to" : "Will move to"}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} style={r.skip ? { opacity: 0.6 } : undefined}>
                    <td>
                      <Link
                        to={`/${r.kind === "invoice" ? "invoices" : "credit-notes"}/${r.id}`}
                      >
                        {r.number}
                      </Link>
                      <div className="small muted">
                        {r.kind === "invoice" ? "Invoice" : "Credit note"}
                      </div>
                    </td>
                    <td className="small">
                      {r.date
                        ? new Date(r.date).toLocaleDateString("en-IN")
                        : ""}
                    </td>
                    <td className="num">{money(r.total)}</td>
                    <td className="small">{r.from}</td>
                    <td className="small">
                      {r.skip ? (
                        <span className="text-red">Skipped — {r.skip}</span>
                      ) : (
                        <>
                          <b>{r.to}</b> <span className="muted">{r.gstin}</span>
                          {r.newBuyer && !done && (
                            <span className="muted"> · new customer</span>
                          )}
                          {done && r.done && " ✓"}
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Modal>
  );
}

function CheckButton({ S, month, onResult }) {
  const ref = useRef(null);
  const [busy, setBusy] = useState(false);
  const pick = async (e) => {
    const fs = [...(e.target.files || [])];
    e.target.value = "";
    if (!fs.length) return;
    setBusy(true);
    await runCheck(S, month, await Promise.all(fs.map(readFile)), onResult);
    setBusy(false);
  };
  return (
    <>
      <input
        ref={ref}
        type="file"
        multiple
        accept=".xlsx,.zip,.csv"
        style={{ display: "none" }}
        onChange={pick}
      />
      <button
        className="btn btn-sm"
        disabled={busy}
        onClick={() => ref.current?.click()}
        title={
          S.key === "pepperfry"
            ? "Select Pepperfry's TCS report for this month"
            : S.key === "flipkart"
              ? "Select Flipkart's GSTR-1 report for this month"
              : "Select Amazon's GSTR-1 report for this month — add the MTR B2C and B2B files too to see each invoice"
        }
      >
        {busy
          ? "Checking…"
          : S.key === "pepperfry"
            ? "Check with Pepperfry TCS report"
            : `Check with ${S.label} GSTR-1`}
      </button>
    </>
  );
}

function ImportBox({ S, onImported }) {
  const [files, setFiles] = useState([]);
  const [raw, setRaw] = useState([]);
  const [pv, setPv] = useState(null);
  const [busy, setBusy] = useState(false);
  const [ledgers, setLedgers] = useState([]);
  const [ledger, setLedger] = useState("");
  const [mode, setMode] = useState("single");
  const [party, setParty] = useState("");
  const [series, setSeries] = useState(null); // { on, prefix, next, width } — own invoice numbers (Pepperfry)
  const [job, setJob] = useState(null);
  useEffect(() => {
    api
      .get("/accounts")
      .then((r) =>
        setLedgers(
          r.data.filter(
            (a) =>
              a.ledgerKind === "sales" ||
              (a.group === "Income" && a.active !== false),
          ),
        ),
      )
      .catch(() => {});
  }, []);
  useEffect(() => {
    const a = ledgers.find((l) => l.name === S.ledger);
    if (a && !ledger) setLedger(a.code || a._id);
  }, [ledgers]);

  const choose = async (e) => {
    const fs = [...(e.target.files || [])];
    setFiles(fs);
    setPv(null);
    setJob(null);
    setRaw(await Promise.all(fs.map(readFile)));
  };
  const preview = async () => {
    setBusy(true);
    try {
      const { data } = await api.post(`${S.api}/preview`, { files: raw });
      setPv(data);
      // Tally-style posting when the company has an "Online Sale" master ledger and an Amazon_SRE party.
      setMode(data.posting?.group ? "online" : "single");
      setParty(data.posting?.party?._id || "");
      setSeries(data.series ? { on: true, ...data.series } : null);
    } catch (e) {
      toast(errMsg(e), "error");
    }
    setBusy(false);
  };
  const start = async () => {
    setBusy(true);
    try {
      const { data } = await api.post(`${S.api}/import`, {
        planId: pv.planId,
        ledger,
        mode,
        party,
        series: series?.on ? { prefix: series.prefix, next: Number(series.next), width: series.width || 0 } : null,
      });
      setJob(data);
      const poll = setInterval(async () => {
        try {
          const { data: j } = await api.get(`${S.api}/jobs/${data.id}`);
          setJob(j);
          if (j.status !== "running") {
            clearInterval(poll);
            setBusy(false);
            toast(
              `Imported ${j.created.invoices} invoices and ${j.created.creditNotes} credit notes${j.errors.length ? ` · ${j.errors.length} not imported` : ""}`,
              j.errors.length ? "error" : undefined,
            );
            const gstr1 = raw.filter(
              (f) =>
                /gstr/i.test(f.name) ||
                /\.xlsx$/i.test(f.name) ||
                /\.zip$/i.test(f.name),
            );
            onImported(pv.month, pv.hasGstr1 ? gstr1 : []);
          }
        } catch {}
      }, 1500);
    } catch (e) {
      toast(errMsg(e), "error");
      setBusy(false);
    }
  };
  const row = (label, p) => (
    <tr>
      <td>{label}</td>
      <td className="num">{p.count}</td>
      <td className="num">{money(p.taxable)}</td>
      <td className="num">{money(p.tax)}</td>
      <td className="num strong">{money(p.value)}</td>
      <td className="num muted">{money(p.tcs)}</td>
    </tr>
  );
  const net = pv && {
    taxable:
      pv.b2cInvoices.taxable + pv.b2bInvoices.taxable + pv.creditNotes.taxable,
    tax: pv.b2cInvoices.tax + pv.b2bInvoices.tax + pv.creditNotes.tax,
    value: pv.b2cInvoices.value + pv.b2bInvoices.value + pv.creditNotes.value,
    tcs: pv.b2cInvoices.tcs + pv.b2bInvoices.tcs + pv.creditNotes.tcs,
  };
  return (
    <div className="card">
      <div className="card-head">
        <h3>Import from {S.label}</h3>
      </div>
      {S.key === "pepperfry" ? (
        <p className="small muted" style={{ marginTop: 0 }}>
          Pepperfry seller panel → Reports: download the{" "}
          <strong>GSTR-1 report</strong> for the month and the{" "}
          <strong>TCS report</strong> (to check against and for TCS). Upload the
          zips as they are. Each Pepperfry order becomes an invoice in your own series (e.g. INV1034, continuing from your books), with Pepperfry's order number kept as Reference# (B2C to your "Pepperfry" party or "Pepperfry B2C",
          B2B to the buyer); each return a credit note "PFCN" + order number,
          dated on the return date. Importing the same month again only adds
          what's new.
        </p>
      ) : S.key === "flipkart" ? (
        <p className="small muted" style={{ marginTop: 0 }}>
          Seller Hub → Reports → Tax reports: download the{" "}
          <strong>Sales Report</strong> for the month (and the{" "}
          <strong>GSTR-1 report</strong> to check against). Upload the Excel
          files as they are. Each Flipkart invoice becomes an invoice (B2C to
          "Flipkart B2C" or your Flipkart party, B2B to the buyer), each return
          or cancellation a credit note; bank-offer cash back notes from the
          Cash Back sheet are included, so the month equals Flipkart's GSTR-8.
          Importing the same month again only adds what's new.
        </p>
      ) : (
        <p className="small muted" style={{ marginTop: 0 }}>
          Seller Central → Reports → Tax Document Library: download{" "}
          <strong>MTR B2C</strong> and <strong>MTR B2B</strong> for the month
          (and the <strong>GSTR-1 report</strong> to check against). Upload the
          zips as they are. Each Amazon invoice becomes an invoice (B2C to
          "Amazon B2C", B2B to the buyer), each refund a credit note;
          cancellations, free replacements and other GSTINs are skipped.
          Importing the same month again only adds what's new.
        </p>
      )}
      <div
        style={{
          display: "flex",
          gap: 8,
          flexWrap: "wrap",
          alignItems: "center",
        }}
      >
        <input
          type="file"
          multiple
          accept=".zip,.csv,.xlsx"
          onChange={choose}
        />
        <button
          className="btn btn-primary"
          disabled={!raw.length || busy}
          onClick={preview}
        >
          {busy && !pv ? "Reading…" : "Preview"}
        </button>
      </div>
      {files.length > 0 && !pv && (
        <p className="small muted">{files.map((f) => f.name).join(", ")}</p>
      )}
      {pv && (
        <div style={{ marginTop: 14 }}>
          <p className="small" style={{ margin: "0 0 8px" }}>
            <strong>{monthLabel(pv.month)}</strong> · seller GSTIN {pv.gstin} ·{" "}
            {pv.files.join(" · ")}
            {pv.unknownFiles.length > 0 && (
              <span style={{ color: "var(--red)" }}>
                {" "}
                · not recognised: {pv.unknownFiles.join(", ")}
              </span>
            )}
          </p>
          <table className="table">
            <thead>
              <tr>
                <th>
                  From{" "}
                  {S.key === "pepperfry"
                    ? "Pepperfry's GSTR-1 report"
                    : S.key === "flipkart"
                      ? "Flipkart's Sales Report"
                      : "Amazon's MTR"}
                </th>
                <th className="num">Documents</th>
                <th className="num">Taxable</th>
                <th className="num">GST</th>
                <th className="num">Value</th>
                <th className="num">TCS by {S.label}</th>
              </tr>
            </thead>
            <tbody>
              {row("B2C invoices", pv.b2cInvoices)}
              {row("B2B invoices", pv.b2bInvoices)}
              {row(
                S.key === "amazon"
                  ? "Refunds (credit notes)"
                  : "Returns & cancellations (credit notes)",
                pv.creditNotes,
              )}
              <tr className="row-total">
                <td>Net sales</td>
                <td />
                <td className="num">{money(net.taxable)}</td>
                <td className="num">{money(net.tax)}</td>
                <td className="num">{money(net.value)}</td>
                <td className="num">{money(net.tcs)}</td>
              </tr>
            </tbody>
          </table>
          <ul className="small" style={{ margin: "10px 0", paddingLeft: 18 }}>
            <li>
              <strong>{pv.toCreate}</strong> to create
              {pv.fromOrders
                ? ` · ${pv.fromOrders} already invoiced from Amazon orders (tagged with Amazon's number, not created again)`
                : ""}
              {pv.alreadyImported
                ? ` · ${pv.alreadyImported} already imported (left as they are)`
                : ""}
              {pv.conflicts.length > 0 && (
                <span style={{ color: "var(--red)" }}>
                  {" "}
                  · {pv.conflicts.length} numbers already used by other
                  documents, skipped: {pv.conflicts.slice(0, 8).join(", ")}
                  {pv.conflicts.length > 8 ? "…" : ""}
                </span>
              )}
            </li>
            {S.key === "amazon" ? (
              <li>
                Skipped lines: {pv.skipped.cancel} cancelled,{" "}
                {pv.skipped.freeReplacement} free replacements
                {Object.entries(pv.skipped.otherGstin).map(
                  ([g, n]) => ` · ${n} of GSTIN ${g}`,
                )}
              </li>
            ) : (
              (pv.skipped.other > 0 ||
                Object.keys(pv.skipped.otherGstin).length > 0) && (
                <li>
                  Skipped rows: {pv.skipped.other} without a document number or
                  value
                  {Object.entries(pv.skipped.otherGstin).map(
                    ([g, n]) => ` · ${n} of GSTIN ${g}`,
                  )}
                </li>
              )
            )}
            {pv.newBuyers.length > 0 && (
              <li>
                {pv.newBuyers.length} new B2B customers will be created:{" "}
                {pv.newBuyers.slice(0, 5).join(", ")}
                {pv.newBuyers.length > 5 ? "…" : ""}
              </li>
            )}
            {pv.unmatchedSkus.length > 0 && (
              <li>
                {pv.unmatchedSkus.length} {S.label} SKUs have no item in
                OrdexaGo — those lines are imported without stock movement:{" "}
                <span className="muted">
                  {pv.unmatchedSkus
                    .slice(0, 12)
                    .map((s) => s.sku)
                    .join(", ")}
                  {pv.unmatchedSkus.length > 12 ? "…" : ""}
                </span>
              </li>
            )}
          </ul>
          {pv.posting?.onParty && party && (
            <div
              className="alert alert-error small"
              style={{ marginBottom: 10 }}
            >
              {pv.posting.party.name} already has {pv.posting.onParty.count}{" "}
              invoices worth {money(pv.posting.onParty.total)} in {pv.month}{" "}
              that didn't come from this import (e.g. from Tally). If those are
              the same {S.label} sales, importing would count them twice — skip
              this month.
            </div>
          )}
          <div
            style={{
              display: "flex",
              gap: 8,
              alignItems: "flex-end",
              flexWrap: "wrap",
            }}
          >
            {series && (
              <Field label="Invoice numbers" hint={series.on ? `From ${series.prefix}${String(series.next).padStart(series.width || 0, "0")} in date order${series.last ? ` (last in your books: ${series.last})` : ""}; ${S.label}'s number stays as Reference#` : `${S.label}'s order numbers`}>
                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <select value={series.on ? "own" : "market"} onChange={(e) => setSeries({ ...series, on: e.target.value === "own" })}>
                    <option value="own">My series</option>
                    <option value="market">{S.label}'s numbers</option>
                  </select>
                  {series.on && (
                    <>
                      <input style={{ width: 70 }} value={series.prefix} onChange={(e) => setSeries({ ...series, prefix: e.target.value })} title="Prefix" />
                      <input style={{ width: 90 }} type="number" min="1" value={series.next} onChange={(e) => setSeries({ ...series, next: e.target.value })} title="Next number" />
                    </>
                  )}
                </div>
              </Field>
            )}
            <Field label="Party (customer)">
              <select value={party} onChange={(e) => setParty(e.target.value)}>
                {pv.posting?.party && (
                  <option value={pv.posting.party._id}>
                    {pv.posting.party.name} for B2C · each business buyer
                    (GSTIN) for B2B
                  </option>
                )}
                <option value="">
                  {S.b2c} + each business buyer separately
                </option>
              </select>
            </Field>
            <Field label="Sales ledgers">
              <select value={mode} onChange={(e) => setMode(e.target.value)}>
                <option value="online">
                  {pv.posting?.group ? `${pv.posting.group}: ` : ""}by type and
                  rate (Local / Outstate · B2B / B2C · GST %)
                </option>
                <option value="single">One ledger for all</option>
              </select>
            </Field>
            {mode === "single" && (
              <Field label="Sales ledger">
                <select
                  value={ledger}
                  onChange={(e) => setLedger(e.target.value)}
                >
                  {!ledgers.some((l) => l.name === S.ledger) && (
                    <option value="">{S.ledger} (new ledger)</option>
                  )}
                  {ledgers.map((l) => (
                    <option key={l.code || l._id} value={l.code || l._id}>
                      {l.name}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            <button
              className="btn btn-primary"
              disabled={busy || !(pv.toCreate || pv.fromOrders)}
              onClick={start}
            >
              <Icon name="upload" size={16} /> Import {pv.toCreate} documents
              {pv.fromOrders ? ` + tag ${pv.fromOrders}` : ""}
            </button>
          </div>
          {mode === "online" && pv.posting?.ledgers?.length > 0 && (
            <p className="small muted" style={{ margin: "8px 0 0" }}>
              Ledgers used:{" "}
              {pv.posting.ledgers
                .map((l) => l.name + (l.exists ? "" : " (new)"))
                .join(", ")}
              {pv.posting.ledgers.some((l) => !l.exists)
                ? `. New ones are created${pv.posting.group ? ` under ${pv.posting.group}` : ""}.`
                : "."}
              {party
                ? ` B2C sales go to ${pv.posting.party.name}; B2B sales to the buyer named on the invoice, found by GSTIN or created.`
                : ""}
            </p>
          )}
          {job && (
            <div style={{ marginTop: 12 }}>
              <div className="meter">
                <div
                  className="meter-current"
                  style={{
                    width: `${job.total ? (job.done / job.total) * 100 : 100}%`,
                  }}
                />
              </div>
              <p className="small" style={{ margin: "6px 0" }}>
                {job.status === "running"
                  ? `Importing… ${job.done} of ${job.total}`
                  : `Done: ${job.created.invoices} invoices, ${job.created.creditNotes} credit notes created${job.created.linked ? `, ${job.created.linked} order invoices tagged` : ""}`}
                {job.errors.length > 0 && (
                  <span style={{ color: "var(--red)" }}>
                    {" "}
                    · {job.errors.length} not imported
                  </span>
                )}
              </p>
              {job.errors.length > 0 && (
                <ul
                  className="small"
                  style={{ color: "var(--red)", margin: 0, paddingLeft: 18 }}
                >
                  {job.errors.slice(0, 15).map((e, i) => (
                    <li key={i}>
                      {e.number}: {e.message}
                    </li>
                  ))}
                </ul>
              )}
              {job.warnings.length > 0 && (
                <ul
                  className="small muted"
                  style={{ margin: 0, paddingLeft: 18 }}
                >
                  {job.warnings.slice(0, 15).map((e, i) => (
                    <li key={i}>
                      {e.number}: {e.message}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function CheckResult({ r, onClose }) {
  const [tab, setTab] = useState("b2c");
  const [open, setOpen] = useState(null);
  const S = r.sections;
  const TABS = [
    ["b2c", "B2C (state & rate)", S.b2c],
    ["b2b", "B2B invoices", S.b2b],
    ["cdnr", "B2B credit notes", S.cdnr],
    ["hsn", "HSN summary", S.hsn],
    ...(S.documents ? [["documents", "Documents", S.documents]] : []),
  ];
  const bad = (sec) =>
    sec === S.documents
      ? sec.rows.filter((x) => x.problem !== "no_hsn").length
      : sec.rows.filter((x) => !x.ok).length;
  return (
    <div className="card" style={{ marginTop: 16, overflowX: "auto" }}>
      <div className="card-head">
        <h3>
          {monthLabel(r.month)} · OrdexaGo vs Amazon's GSTR-1 ({r.gstin})
        </h3>
        <button className="link-btn" onClick={onClose}>
          Close
        </button>
      </div>
      <p className="small muted" style={{ marginTop: 0 }}>
        {r.file} · imported for this month: {r.imported.invoices} invoices,{" "}
        {r.imported.creditNotes} credit notes, net taxable{" "}
        {money(r.imported.taxable)}, net value {money(r.imported.value)}.
      </p>
      <div className="tabs" style={{ marginBottom: 10 }}>
        {TABS.map(([k, l, sec]) => (
          <button
            key={k}
            type="button"
            className={`tab ${tab === k ? "active" : ""}`}
            onClick={() => setTab(k)}
          >
            {sec.ok ? "✓" : "✗"} {l}{" "}
            <span className={`tab-count ${sec.ok ? "" : "red"}`}>
              {sec.ok ? sec.rows.length : `${bad(sec)} off`}
            </span>
          </button>
        ))}
      </div>
      {tab === "hsn" && S.documents?.noHsnProducts?.length > 0 && (
        <div className="alert alert-info small" style={{ marginBottom: 10 }}>
          <b>Products Amazon reported without an HSN</b> — OrdexaGo used the HSN
          from your item master, so these invoices are correct but Amazon's HSN
          summary shows them under "no HSN". Add the HSN to these listings in
          Seller Central:
          <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
            {S.documents.noHsnProducts.map((p) => (
              <li key={p.sku}>
                <b>{p.sku}</b> — OrdexaGo used HSN {p.hsn} · {p.invoices}{" "}
                document{p.invoices === 1 ? "" : "s"} · taxable{" "}
                {money(p.taxable)}
              </li>
            ))}
          </ul>
          The invoices are listed in the Documents tab ("No HSN from Amazon").
        </div>
      )}
      {(tab === "b2c" || tab === "hsn") && (
        <table className="table">
          <thead>
            <tr>
              <th>{tab === "b2c" ? "Place of supply @ rate" : "HSN @ rate"}</th>
              <th className="num">Amazon taxable</th>
              <th className="num">OrdexaGo taxable</th>
              <th className="num">Difference</th>
            </tr>
          </thead>
          <tbody>
            {S[tab].rows.map((x) => (
              <Fragment key={x.key}>
                <tr
                  style={
                    x.ok
                      ? undefined
                      : { background: "var(--red-50)", cursor: "pointer" }
                  }
                  onClick={
                    x.ok
                      ? undefined
                      : () => setOpen(open === x.key ? null : x.key)
                  }
                  title={x.ok ? "" : "Click to see the documents in this row"}
                >
                  <td>
                    {!x.ok && (
                      <span style={{ display: "inline-block", width: 14 }}>
                        {open === x.key ? "▾" : "▸"}
                      </span>
                    )}
                    {x.label}
                  </td>
                  <td className="num">{money(x.amazon)}</td>
                  <td className="num">{money(x.ordexago)}</td>
                  <td className="num">{x.ok ? "✓" : money(x.diff)}</td>
                </tr>
                {open === x.key && x.docs && (
                  <tr>
                    <td
                      colSpan={4}
                      style={{
                        background: "var(--bg)",
                        padding: "8px 12px 12px 26px",
                      }}
                    >
                      {x.sides !== "both" && (
                        <p
                          className="small"
                          style={{ margin: "0 0 6px", color: "var(--red)" }}
                        >
                          OrdexaGo doesn't have Amazon's per-invoice figures for
                          this month yet, so it can only list its own documents.
                          Run the check once more with the MTR B2C and B2B files
                          selected together with the GSTR-1 — they're kept, so
                          after that every check shows exactly which invoices
                          need correcting.
                        </p>
                      )}
                      {x.sides === "both" && (
                        <p className="small" style={{ margin: "0 0 6px" }}>
                          <b>
                            {
                              x.docs.filter(
                                (d) =>
                                  d.status === "missing" ||
                                  d.status === "differs",
                              ).length
                            }
                          </b>{" "}
                          to correct
                          {x.docs.some((d) => d.status === "regrouped")
                            ? ` · ${x.docs.filter((d) => d.status === "regrouped").length} correct but grouped under another ${tab === "hsn" ? "HSN" : "state or rate"} (nothing to do)`
                            : ""}
                        </p>
                      )}
                      <table className="table" style={{ margin: 0 }}>
                        <thead>
                          <tr>
                            <th>Document</th>
                            {x.sides === "both" && (
                              <th className="num">Amazon taxable</th>
                            )}
                            <th className="num">OrdexaGo taxable</th>
                            {x.sides === "both" && (
                              <th className="num">Difference</th>
                            )}
                            {x.sides === "both" && <th>Status</th>}
                          </tr>
                        </thead>
                        <tbody>
                          {x.docs
                            .filter(
                              (d) => x.sides !== "both" || d.status !== "ok",
                            )
                            .sort((a, b) =>
                              x.sides === "both"
                                ? (a.status === "regrouped") -
                                  (b.status === "regrouped")
                                : 0,
                            )
                            .slice(0, 300)
                            .map((d) => (
                              <tr key={d.kind + d.number}>
                                <td>
                                  {d.id ? (
                                    <Link
                                      to={`/${d.kind === "invoice" ? "invoices" : "credit-notes"}/${d.id}`}
                                    >
                                      {d.number}
                                    </Link>
                                  ) : (
                                    <span title="Not in OrdexaGo">
                                      {d.number}
                                    </span>
                                  )}{" "}
                                  <span className="small muted">
                                    {d.kind === "invoice"
                                      ? "invoice"
                                      : "credit note"}
                                  </span>
                                </td>
                                {x.sides === "both" && (
                                  <td className="num">{money(d.amazon)}</td>
                                )}
                                <td className="num">
                                  {d.elsewhere ? (
                                    <span className="small muted">
                                      {tab === "hsn"
                                        ? "under another HSN / rate"
                                        : "under another state / rate, or as B2B"}
                                    </span>
                                  ) : d.id ? (
                                    money(d.ordexago)
                                  ) : (
                                    <span className="text-red small">
                                      not in OrdexaGo
                                    </span>
                                  )}
                                </td>
                                {x.sides === "both" && (
                                  <td className="num">{money(d.diff)}</td>
                                )}
                                {x.sides === "both" && (
                                  <td className="small">
                                    {d.status === "missing" && (
                                      <span className="text-red">
                                        Correct: not in OrdexaGo — import the
                                        MTR again
                                      </span>
                                    )}
                                    {d.status === "differs" && (
                                      <span className="text-red">
                                        Correct: amount differs — open and fix
                                      </span>
                                    )}
                                    {d.status === "regrouped" && (
                                      <span className="muted">
                                        OK — whole invoice matches; HSN from
                                        item master
                                      </span>
                                    )}
                                  </td>
                                )}
                              </tr>
                            ))}
                        </tbody>
                      </table>
                      {x.sides === "both" &&
                        !x.docs.some((d) => d.status !== "ok") && (
                          <p className="small muted">
                            Each document matches; nothing to correct.
                          </p>
                        )}
                      {x.sides !== "both" && x.docs.length > 300 && (
                        <p className="small muted">
                          First 300 of {x.docs.length}.
                        </p>
                      )}
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
            <tr className="row-total">
              <td>Total</td>
              <td className="num">{money(S[tab].amazon)}</td>
              <td className="num">{money(S[tab].ordexago)}</td>
              <td className="num">
                {Math.abs(S[tab].amazon - S[tab].ordexago) < 0.05
                  ? "✓"
                  : money(S[tab].ordexago - S[tab].amazon)}
              </td>
            </tr>
          </tbody>
        </table>
      )}
      {!S.documents && (
        <p className="small" style={{ color: "var(--red)" }}>
          To see exactly which invoices need correcting (and which products came
          without HSN), run the check once more selecting the MTR B2C and B2B
          files together with the GSTR-1. OrdexaGo keeps them, so you won't need
          to add them again for this month.
        </p>
      )}
      {tab === "documents" && S.documents && (
        <>
          <p className="small muted" style={{ marginTop: 0 }}>
            {S.documents.checked} Amazon documents checked against what was
            imported.
            {S.documents.missingTaxable
              ? ` Missing documents account for ${money(S.documents.missingTaxable)} of taxable value.`
              : ""}
          </p>
          <table className="table">
            <thead>
              <tr>
                <th>Document</th>
                <th>Date</th>
                <th className="num">Amazon taxable</th>
                <th className="num">OrdexaGo taxable</th>
                <th>What to do</th>
              </tr>
            </thead>
            <tbody>
              {S.documents.rows.map((x, i) => (
                <tr
                  key={i}
                  style={
                    x.problem === "no_hsn"
                      ? undefined
                      : { background: "var(--red-50)" }
                  }
                >
                  <td>
                    {x.id ? (
                      <Link
                        to={`/${x.kind === "invoice" ? "invoices" : "credit-notes"}/${x.id}`}
                      >
                        {x.number}
                      </Link>
                    ) : (
                      x.number
                    )}
                    <div className="small muted">
                      {x.kind === "invoice" ? "Invoice" : "Credit note"}
                      {x.b2b ? " · B2B" : ""}
                    </div>
                  </td>
                  <td className="small">{x.date}</td>
                  <td className="num">
                    {x.amazon == null ? "—" : money(x.amazon)}
                  </td>
                  <td className="num">
                    {x.ordexago == null ? "—" : money(x.ordexago)}
                  </td>
                  <td className="small" style={{ maxWidth: 520 }}>
                    <strong>
                      {
                        {
                          missing: "Missing",
                          differs: "Differs",
                          extra: "Extra",
                          no_hsn: "No HSN from Amazon",
                        }[x.problem]
                      }
                      .
                    </strong>{" "}
                    {x.note}
                  </td>
                </tr>
              ))}
              {!S.documents.rows.length && (
                <tr>
                  <td colSpan={5} className="muted center">
                    Every document matches
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </>
      )}
      {(tab === "b2b" || tab === "cdnr") && (
        <table className="table">
          <thead>
            <tr>
              <th>{tab === "b2b" ? "Invoice" : "Credit note"}</th>
              {tab === "b2b" && <th>Buyer GSTIN</th>}
              <th className="num">Amazon value</th>
              <th className="num">Amazon taxable</th>
              <th className="num">OrdexaGo value</th>
              <th className="num">OrdexaGo taxable</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {S[tab].rows.map((x) => (
              <tr
                key={x.number}
                style={x.ok ? undefined : { background: "var(--red-50)" }}
              >
                <td>
                  {x.id ? (
                    <Link
                      to={`/${tab === "b2b" ? "invoices" : "credit-notes"}/${x.id}`}
                    >
                      {x.number}
                    </Link>
                  ) : (
                    x.number
                  )}
                </td>
                {tab === "b2b" && <td className="small">{x.gstin}</td>}
                <td className="num">
                  {x.amazon ? money(x.amazon.value) : "—"}
                </td>
                <td className="num">
                  {x.amazon ? money(x.amazon.taxable) : "—"}
                </td>
                <td className="num">
                  {x.ordexago ? money(x.ordexago.value) : "—"}
                </td>
                <td className="num">
                  {x.ordexago ? money(x.ordexago.taxable) : "—"}
                </td>
                <td className="small">
                  {x.ok
                    ? "✓"
                    : !x.ordexago
                      ? "Not in OrdexaGo"
                      : !x.amazon
                        ? "Not in Amazon's GSTR-1"
                        : "Differs"}
                </td>
              </tr>
            ))}
            {!S[tab].rows.length && (
              <tr>
                <td colSpan={7} className="muted center">
                  None this month
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </div>
  );
}

// OrdexaGo's imported Flipkart month vs Flipkart's GSTR-1 / GSTR-8 report.
function FlipkartCheck({ S, r, onClose }) {
  const mark = (ok) => (
    <span style={{ color: ok ? "var(--green, #15803d)" : "var(--red)" }}>
      {ok ? "✓" : "Differs"}
    </span>
  );
  return (
    <Modal
      open
      wide
      title={`${monthLabel(r.month)} · OrdexaGo vs ${S.label}'s ${S.key === "pepperfry" ? "TCS report" : "GSTR-1"} (${r.gstin})`}
      onClose={onClose}
    >
      <p className="small">
        {r.documents.invoices} invoices and {r.documents.creditNotes} credit
        notes imported for this month.{" "}
        {r.ok
          ? `Totals match ${S.label}'s report.`
          : "Some totals differ — see below."}
        {r.tcs ? ` TCS collected by ${S.label}: ${money(r.tcs)}.` : ""}
      </p>
      <table className="table">
        <thead>
          <tr>
            <th>Total</th>
            <th className="num">{S.label}</th>
            <th className="num">OrdexaGo</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {r.totals.map((x) => (
            <tr key={x.label}>
              <td>{x.label}</td>
              <td className="num">{money(x.flipkart)}</td>
              <td className="num">{money(x.ordexago)}</td>
              <td className="small">{mark(x.ok)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {r.b2cs.rows.length > 0 && (
        <>
          <h4 className="section-title">
            B2C by place of supply and rate (GSTR-1 Table 7)
          </h4>
          <table className="table">
            <thead>
              <tr>
                <th>Place of supply</th>
                <th className="num">Rate</th>
                <th className="num">Flipkart taxable</th>
                <th className="num">OrdexaGo taxable</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {r.b2cs.rows.map((x, i) => (
                <tr key={i}>
                  <td>{x.pos || "Within the state (7A)"}</td>
                  <td className="num">{x.rate}%</td>
                  <td className="num">{money(x.flipkart)}</td>
                  <td className="num">{money(x.ordexago)}</td>
                  <td className="small">{mark(x.ok)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {r.hsn.rows.length > 0 && (
        <>
          <h4 className="section-title">HSN summary (GSTR-1 Table 12)</h4>
          <table className="table">
            <thead>
              <tr>
                <th>HSN</th>
                <th className="num">Flipkart taxable</th>
                <th className="num">OrdexaGo taxable</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {r.hsn.rows.map((x) => (
                <tr key={x.hsn}>
                  <td>{x.hsn}</td>
                  <td className="num">{money(x.flipkart)}</td>
                  <td className="num">{money(x.ordexago)}</td>
                  <td className="small">{mark(x.ok)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {r.hsn.rows.length > 0 && (
        <p className="small muted">
          Flipkart's HSN summary shows returns of earlier months under each HSN
          the way Flipkart counts them; a small difference in one HSN with
          matching totals is usually that.
        </p>
      )}
    </Modal>
  );
}
