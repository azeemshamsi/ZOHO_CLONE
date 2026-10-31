import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import api, { errMsg } from "../lib/api";
import { money, date, isoDate } from "../lib/format";
import { parseBankDate, parseAmount, guessColumns, findHeaderRow } from "../lib/csv";
import { readStatementFile, ACCEPT } from "../lib/statement";
import { PageHeader, Spinner, Empty, Field, toast, Modal, Status, Confirm } from "../components/ui";
import { clearBankAccountCache } from "../components/BankAccountSelect";
import { docLink } from "./Accounts";
import Icon from "../components/Icon";

/* ===================== Overview ===================== */
function AddAccountModal({ open, onClose, onSaved }) {
  const [f, setF] = useState({ name: "", group: "Bank", accountCode: "", description: "" });
  const [busy, setBusy] = useState(false);
  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.post("/banking/accounts", f);
      clearBankAccountCache();
      toast("Account added");
      setF({ name: "", group: "Bank", accountCode: "", description: "" });
      onSaved();
    } catch (err) {
      toast(errMsg(err), "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={open} onClose={onClose} title="Add Bank or Cash Account">
      <form className="stack" onSubmit={save}>
        <Field label="Account Type">
          <div className="radio-row">
            {["Bank", "Cash"].map((g) => (
              <label key={g} className="radio">
                <input type="radio" checked={f.group === g} onChange={() => setF({ ...f, group: g })} /> {g}
              </label>
            ))}
          </div>
        </Field>
        <Field label="Account Name" required hint="e.g. HDFC Current A/c, Petty Cash – Shop">
          <input required autoFocus value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        </Field>
        <Field label="Account Number (last 4 digits)">
          <input maxLength={20} value={f.accountCode} onChange={(e) => setF({ ...f, accountCode: e.target.value })} />
        </Field>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={busy}>
            Save
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function BankingHome() {
  const [rows, setRows] = useState(null);
  const [modal, setModal] = useState(false);
  const navigate = useNavigate();
  const load = () => api.get("/banking/accounts").then((r) => setRows(r.data));
  useEffect(() => {
    load();
  }, []);
  if (!rows) return <Spinner />;
  const total = rows.reduce((s, a) => s + a.balance, 0);
  return (
    <>
      <PageHeader title="Banking" subtitle={`Total in cash and bank: ${money(total)}`}>
        <button className="btn btn-primary" onClick={() => setModal(true)}>
          <Icon name="plus" size={16} /> Add Bank Account
        </button>
      </PageHeader>
      <div className="bank-grid">
        {rows.map((a) => (
          <button key={a.code} className="card bank-card" onClick={() => navigate(`/banking/${encodeURIComponent(a.code)}`)}>
            <div className="bank-card-head">
              <span className="bank-icon">
                <Icon name="bank" />
              </span>
              <div>
                <strong>{a.name}</strong>
                <div className="muted small">
                  {a.group}
                  {a.accountCode ? ` · ••${a.accountCode.slice(-4)}` : ""}
                </div>
              </div>
            </div>
            <div className="bank-figures">
              <div>
                <span className="muted small">Balance in MGI</span>
                <strong className={a.balance < 0 ? "text-overdue" : ""}>{money(a.balance)}</strong>
              </div>
              {a.statement.lastBalance !== null ? (
                <div>
                  <span className="muted small">Bank balance · {date(a.statement.lastBalanceDate)}</span>
                  <strong>{money(a.statement.lastBalance)}</strong>
                </div>
              ) : (
                <div>
                  <span className="muted small">Statement lines</span>
                  <strong>{a.statement.lines}</strong>
                </div>
              )}
            </div>
            {a.statement.unmatched > 0 ? (
              <span className="pill pill-amber">{a.statement.unmatched} to match or categorise</span>
            ) : a.statement.lines > 0 ? (
              <span className="pill pill-green">All statement lines handled</span>
            ) : (
              <span className="pill">No statement imported</span>
            )}
          </button>
        ))}
      </div>
      <AddAccountModal open={modal} onClose={() => setModal(false)} onSaved={() => (setModal(false), load())} />
    </>
  );
}

/* ===================== Import ===================== */
function ImportModal({ open, account, onClose, onDone }) {
  const [book, setBook] = useState(null); // { sheets: [{name, rows}] }
  const [sheetIdx, setSheetIdx] = useState(0);
  const [readError, setReadError] = useState("");
  const [reading, setReading] = useState(false);
  const [rows, setRows] = useState(null);
  const [headerIdx, setHeaderIdx] = useState(0);
  const [map, setMap] = useState(null);
  const [useAmount, setUseAmount] = useState(false);
  const [busy, setBusy] = useState(false);
  const [fileName, setFileName] = useState("");

  useEffect(() => {
    if (!open) {
      setRows(null);
      setBook(null);
      setMap(null);
      setFileName("");
      setReadError("");
    }
  }, [open]);

  const useSheet = (all) => {
    const h = findHeaderRow(all);
    const guess = guessColumns(all[h] || []);
    setRows(all);
    setHeaderIdx(h);
    setMap(guess);
    setUseAmount(guess.deposit === -1 && guess.withdrawal === -1 && guess.amount !== -1);
  };

  const onFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setFileName(file.name);
    setReadError("");
    setRows(null);
    setReading(true);
    try {
      const b = await readStatementFile(file);
      setBook(b);
      setSheetIdx(b.defaultSheet);
      useSheet(b.sheets[b.defaultSheet].rows);
    } catch (err) {
      setBook(null);
      setReadError(err.message || "Couldn't read this file");
    } finally {
      setReading(false);
    }
  };

  const header = rows ? rows[headerIdx] || [] : [];
  const parsed = useMemo(() => {
    if (!rows || !map) return [];
    return rows.slice(headerIdx + 1).map((r) => {
      const dateStr = parseBankDate(r[map.date]);
      let deposit = 0;
      let withdrawal = 0;
      if (useAmount) {
        const a = parseAmount(r[map.amount]);
        const flag = map.drcr >= 0 ? String(r[map.drcr] || "").trim().toLowerCase() : "";
        if (flag) {
          // Separate Dr/Cr column: D, DR, Debit, Withdrawal → money out.
          if (/^(d|dr|debit|withdraw)/.test(flag)) withdrawal = Math.abs(a);
          else deposit = Math.abs(a);
        } else if (a >= 0) deposit = a;
        else withdrawal = -a;
      } else {
        deposit = Math.abs(parseAmount(r[map.deposit]));
        withdrawal = Math.abs(parseAmount(r[map.withdrawal]));
      }
      const balRaw = map.balance >= 0 ? String(r[map.balance] ?? "").trim() : "";
      return {
        date: dateStr,
        description: map.description >= 0 ? r[map.description] || "" : "",
        reference: map.reference >= 0 ? r[map.reference] || "" : "",
        deposit,
        withdrawal,
        balance: balRaw && balRaw !== "-" ? parseAmount(balRaw) : null,
      };
    });
  }, [rows, map, headerIdx, useAmount]);
  const good = parsed.filter((r) => r.date && (r.deposit || r.withdrawal));
  const bad = parsed.length - good.length;

  const save = async () => {
    setBusy(true);
    try {
      const { data } = await api.post(`/banking/${encodeURIComponent(account.code)}/import`, { rows: good });
      toast(`Imported ${data.imported} lines${data.skipped ? `, skipped ${data.skipped} already imported` : ""}`);
      onDone();
    } catch (e) {
      toast(errMsg(e), "error");
    } finally {
      setBusy(false);
    }
  };

  const ColSelect = ({ k, label, optional }) => (
    <Field label={label}>
      <select value={map[k]} onChange={(e) => setMap({ ...map, [k]: Number(e.target.value) })}>
        {optional && <option value={-1}>— none —</option>}
        {header.map((h, i) => (
          <option key={i} value={i}>
            {h || `Column ${i + 1}`}
          </option>
        ))}
      </select>
    </Field>
  );

  return (
    <Modal
      open={open}
      onClose={onClose}
      wide
      title={`Import statement · ${account?.name || ""}`}
      footer={
        rows && (
          <>
            <span className="muted small" style={{ marginRight: "auto" }}>
              {good.length} transactions ready{bad ? ` · ${bad} other row${bad > 1 ? "s" : ""} ignored (headings, totals, notes)` : ""}
            </span>
            <button className="btn" onClick={onClose}>
              Cancel
            </button>
            <button className="btn btn-primary" disabled={busy || !good.length} onClick={save}>
              Import {good.length} lines
            </button>
          </>
        )
      }
    >
      <div className="stack">
        <p className="muted small">
          Download your statement from net banking in <strong>Excel (.xls / .xlsx)</strong> or <strong>CSV</strong> format and upload it as is. Lines already
          imported are skipped automatically.
        </p>
        <label className="file-drop">
          <input type="file" accept={ACCEPT} onChange={onFile} />
          <Icon name="doc" /> {reading ? "Reading…" : fileName || "Choose a statement file (.xlsx, .xls, .csv, .ods, .txt)"}
        </label>
        {readError && <div className="alert alert-error">{readError}</div>}
        {book && book.sheets.length > 1 && (
          <Field label="Sheet">
            <select
              value={sheetIdx}
              onChange={(e) => {
                const i = Number(e.target.value);
                setSheetIdx(i);
                useSheet(book.sheets[i].rows);
              }}
            >
              {book.sheets.map((sh, i) => (
                <option key={i} value={i}>
                  {sh.name} ({sh.rows.length} rows)
                </option>
              ))}
            </select>
          </Field>
        )}
        {rows && map && (
          <>
            <Field label="Header row" hint="The row with the column names. Rows above it (bank name, account details) are ignored.">
              <select
                value={headerIdx}
                onChange={(e) => {
                  const h = Number(e.target.value);
                  const guess = guessColumns(rows[h] || []);
                  setHeaderIdx(h);
                  setMap(guess);
                  setUseAmount(guess.deposit === -1 && guess.withdrawal === -1 && guess.amount !== -1);
                }}
              >
                {rows.slice(0, 40).map((r, i) => (
                  <option key={i} value={i}>
                    Row {i + 1}: {r.filter(Boolean).slice(0, 4).join(" | ").slice(0, 80)}
                  </option>
                ))}
              </select>
            </Field>
            <div className="row-3">
              <ColSelect k="date" label="Date column" />
              <ColSelect k="description" label="Description column" optional />
              <ColSelect k="reference" label="Reference column" optional />
            </div>
            <label className="check">
              <input type="checkbox" checked={useAmount} onChange={(e) => setUseAmount(e.target.checked)} /> One amount column (with a Dr/Cr column, or money out shown as negative)
            </label>
            <div className="row-3">
              {useAmount ? (
                <>
                  <ColSelect k="amount" label="Amount column" />
                  <ColSelect k="drcr" label="Dr / Cr column" optional />
                </>
              ) : (
                <>
                  <ColSelect k="deposit" label="Deposits / Credit column" optional />
                  <ColSelect k="withdrawal" label="Withdrawals / Debit column" optional />
                </>
              )}
              <ColSelect k="balance" label="Balance column" optional />
            </div>
            <table className="table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Description</th>
                  <th className="num">Deposit</th>
                  <th className="num">Withdrawal</th>
                  <th className="num">Balance</th>
                </tr>
              </thead>
              <tbody>
                {good.slice(0, 6).map((r, i) => (
                  <tr key={i}>
                    <td>{date(r.date)}</td>
                    <td className="clamp">{r.description}</td>
                    <td className="num">{r.deposit ? money(r.deposit) : ""}</td>
                    <td className="num">{r.withdrawal ? money(r.withdrawal) : ""}</td>
                    <td className="num muted">{r.balance !== null ? money(r.balance) : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {good.length > 6 && <p className="muted small">…and {good.length - 6} more transactions</p>}
            {!good.length && <div className="alert alert-error">No transactions found. Check the header row and column choices above.</div>}
          </>
        )}
      </div>
    </Modal>
  );
}

/* ===================== Match / categorise ===================== */
function MatchModal({ line, accounts, bankCode, onClose, onDone }) {
  const [sugs, setSugs] = useState(null);
  const [pick, setPick] = useState("");
  const [cat, setCat] = useState({ account: "", taxRate: 0, notes: "" });
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!line) return;
    setSugs(null);
    setPick("");
    setCat({ account: "", taxRate: 0, notes: line.description });
    api.get(`/banking/lines/${line._id}/suggestions`).then((r) => {
      setSugs(r.data);
      if (r.data[0] && r.data[0].days <= 7) setPick(r.data[0].key);
    });
  }, [line]);
  if (!line) return null;
  const isOut = line.withdrawal > 0;
  const choices = accounts.filter((a) => !["ar", "ap", bankCode].includes(a.code) && a.active !== false);
  const groups = [...new Set(choices.map((a) => a.group))];
  const chosen = choices.find((a) => a.code === cat.account);

  const run = async (fn, msg) => {
    setBusy(true);
    try {
      await fn();
      toast(msg);
      onDone();
    } catch (e) {
      toast(errMsg(e), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={!!line} onClose={onClose} wide title={isOut ? `Money out · ${money(line.withdrawal)}` : `Money in · ${money(line.deposit)}`}>
      <div className="stack">
        <div className="customer-chip">
          <span>{date(line.date)}</span>
          <span>{line.description}</span>
          {line.reference && <span className="mono">{line.reference}</span>}
        </div>

        <h4 className="section-title" style={{ marginTop: 0 }}>
          Match with a transaction already in MGI
        </h4>
        {!sugs ? (
          <Spinner />
        ) : !sugs.length ? (
          <p className="muted small">
            Nothing in MGI for this exact amount. If it's a customer payment or a bill payment, record it first (
            <Link to="/payments/new">Record Payment</Link> · <Link to="/payments-made/new">Payment Made</Link>) using this bank account, then come back to
            match. Otherwise categorise it below.
          </p>
        ) : (
          <div className="match-list">
            {sugs.map((s) => (
              <label key={s.key} className={`match-row ${pick === s.key ? "on" : ""}`}>
                <input type="radio" checked={pick === s.key} onChange={() => setPick(s.key)} />
                <span>
                  <strong>{s.type}</strong> {s.number} {s.party && <span className="muted">· {s.party}</span>}
                </span>
                <span className="muted small">
                  {date(s.date)} {s.days ? `(${s.days} day${s.days > 1 ? "s" : ""} apart)` : "(same day)"}
                </span>
                <strong>{money(s.amount)}</strong>
              </label>
            ))}
            <div className="right">
              <button className="btn btn-primary" disabled={!pick || busy} onClick={() => run(() => api.post(`/banking/lines/${line._id}/match`, { key: pick }), "Matched")}>
                Match
              </button>
            </div>
          </div>
        )}

        <h4 className="section-title">Or categorise it as a new transaction</h4>
        <div className="row-3">
          <Field label="Account" required>
            <select value={cat.account} onChange={(e) => setCat({ ...cat, account: e.target.value })}>
              <option value="">Select an account</option>
              {groups.map((g) => (
                <optgroup key={g} label={g}>
                  {choices
                    .filter((a) => a.group === g)
                    .map((a) => (
                      <option key={a.code} value={a.code}>
                        {a.name}
                      </option>
                    ))}
                </optgroup>
              ))}
            </select>
          </Field>
          {isOut && chosen?.type === "expense" && (
            <Field label="GST included" hint="Splits out input tax credit">
              <select value={cat.taxRate} onChange={(e) => setCat({ ...cat, taxRate: Number(e.target.value) })}>
                {[0, 5, 12, 18, 28].map((r) => (
                  <option key={r} value={r}>
                    {r ? `${r}%` : "None"}
                  </option>
                ))}
              </select>
            </Field>
          )}
          <Field label="Notes">
            <input value={cat.notes} onChange={(e) => setCat({ ...cat, notes: e.target.value })} />
          </Field>
        </div>
        <p className="muted small">
          {chosen
            ? isOut && chosen.type === "expense"
              ? `Records an expense in "${chosen.name}" paid from this account.`
              : `Records a journal: ${isOut ? `${chosen.name} ← this account` : `this account ← ${chosen.name}`}.`
            : "Bank charges and spending → an expense account. Owner's money in or out → Owner's Equity / Drawings. Interest → Other Income."}
        </p>
        <div className="right">
          <button className="btn btn-primary" disabled={!cat.account || busy} onClick={() => run(() => api.post(`/banking/lines/${line._id}/categorize`, cat), "Categorised")}>
            Categorise
          </button>
        </div>
      </div>
    </Modal>
  );
}

/* ===================== Reconciliation ===================== */
function BrsSection({ title, items, renderLabel }) {
  if (!items.length) return null;
  const total = items.reduce((t, i) => t + i.show, 0);
  return (
    <>
      <tr className="row-section">
        <td colSpan={2}>{title}</td>
      </tr>
      {items.map((it, i) => (
        <tr key={it._id || `${it.type}-${it.id}-${i}`}>
          <td className="indent">{renderLabel(it)}</td>
          <td className="num">{money(it.show)}</td>
        </tr>
      ))}
      <tr className="row-subtotal">
        <td>Total</td>
        <td className="num">{money(total)}</td>
      </tr>
    </>
  );
}

function StatementItem({ l, openLine }) {
  return (
    <>
      {date(l.date)} · {l.description}
      {l.excluded ? (
        <span className="muted"> (excluded)</span>
      ) : (
        <>
          {" "}
          <button className="link-btn" onClick={() => openLine({ ...l, deposit: l.amount > 0 ? l.amount : 0, withdrawal: l.amount < 0 ? -l.amount : 0 })}>
            Match / Categorise
          </button>
        </>
      )}
    </>
  );
}
function Reconcile({ code, acc, onChanged, openLine, version }) {
  const [asOf, setAsOf] = useState(() => (acc.statement.lastDate ? isoDate(acc.statement.lastDate) : isoDate()));
  const [override, setOverride] = useState("");
  const [r, setR] = useState(null);
  const [history, setHistory] = useState([]);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const enc = encodeURIComponent(code);

  const load = () => {
    setR(null);
    api.get(`/banking/${enc}/reconcile`, { params: { asOf, statementBalance: override === "" ? undefined : override } }).then((x) => setR(x.data));
    api.get(`/banking/${enc}/reconciliations`).then((x) => setHistory(x.data));
  };
  useEffect(() => {
    load();
  }, [asOf, override, code, version]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    setBusy(true);
    try {
      await api.post(`/banking/${enc}/reconciliations`, { asOf, statementBalance: r.statementBalance, notes });
      toast(r.reconciled ? "Reconciliation saved" : "Saved with a difference — check it later");
      setNotes("");
      load();
      onChanged();
    } catch (e) {
      toast(errMsg(e), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <div className="card form-grid recon-controls">
        <div className="row-3">
          <Field label="Reconcile as of" hint="Usually the last date on your bank statement">
            <input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
          </Field>
          <Field
            label="Balance as per bank"
            hint={r?.autoBalance !== null && r?.autoBalance !== undefined ? `From the imported file: ${money(r.autoBalance)}` : "Enter the closing balance shown on your statement"}
          >
            <input
              type="number"
              step="0.01"
              placeholder={r?.autoBalance !== null && r?.autoBalance !== undefined ? String(r.autoBalance) : "0.00"}
              value={override}
              onChange={(e) => setOverride(e.target.value)}
            />
          </Field>
        </div>
      </div>

      {!r ? (
        <Spinner />
      ) : (
        <>
          {r.balanceBreaks.length > 0 && (
            <div className="alert alert-error">
              The bank's running balance breaks on {r.balanceBreaks.map((b) => date(b.date)).join(", ")} — a transaction is probably missing from the imported
              statement just before {r.balanceBreaks.length > 1 ? "those dates" : "that date"}.
            </div>
          )}
          {r.openingDifference ? (
            <div className="alert alert-error">
              Opening balance mismatch: the statement starts at {money(r.statementOpening)} on {date(r.statementStart)}, but MGI shows {money(r.bookOpening)} the
              day before. Record the opening balance with a manual journal (against Opening Balance Equity) or check earlier entries.
            </div>
          ) : null}

          <div className="report-paper">
            <div className="report-head">
              <div className="muted">{acc.name}</div>
              <h2>Bank Reconciliation Statement</h2>
              <div className="muted small">As of {date(asOf)}</div>
            </div>
            <table className="report-table">
              <tbody>
                <tr className="row-total">
                  <td>Balance as per MGI books</td>
                  <td className="num">{money(r.bookBalance)}</td>
                </tr>
                <BrsSection
                  title="Add: cheques issued / payments recorded in MGI but not yet cleared by the bank"
                  items={r.uncleared.filter((u) => u.amount < 0).map((u) => ({ ...u, show: -u.amount }))}
                  renderLabel={(u) => (
                    <>
                      {date(u.date)} · <Link to={docLink(u.type, u.id)}>{u.type} {u.number}</Link> {u.party && <span className="muted">· {u.party}</span>}
                    </>
                  )}
                />
                <BrsSection
                  title="Less: deposits recorded in MGI but not yet credited by the bank"
                  items={r.uncleared.filter((u) => u.amount > 0).map((u) => ({ ...u, show: u.amount }))}
                  renderLabel={(u) => (
                    <>
                      {date(u.date)} · <Link to={docLink(u.type, u.id)}>{u.type} {u.number}</Link> {u.party && <span className="muted">· {u.party}</span>}
                    </>
                  )}
                />
                <BrsSection
                  title="Add: money received in the bank but not yet recorded in MGI"
                  items={[...r.notInBooks, ...r.excluded.map((x) => ({ ...x, excluded: true }))].filter((l) => l.amount > 0).map((l) => ({ ...l, show: l.amount }))}
                  renderLabel={(l) => <StatementItem l={l} openLine={openLine} />}
                />
                <BrsSection
                  title="Less: money paid from the bank but not yet recorded in MGI"
                  items={[...r.notInBooks, ...r.excluded.map((x) => ({ ...x, excluded: true }))].filter((l) => l.amount < 0).map((l) => ({ ...l, show: -l.amount }))}
                  renderLabel={(l) => <StatementItem l={l} openLine={openLine} />}
                />
                <tr className="row-total">
                  <td>Adjusted balance (what the bank should show)</td>
                  <td className="num">{money(r.adjusted)}</td>
                </tr>
                <tr className="row-total">
                  <td>Balance as per bank statement</td>
                  <td className="num">{r.statementBalance === null ? <span className="muted">enter above</span> : money(r.statementBalance)}</td>
                </tr>
                <tr className="row-grand">
                  <td>{r.reconciled ? "Reconciled — no difference" : "Unexplained difference"}</td>
                  <td className={`num ${r.reconciled ? "text-paid" : "text-overdue"}`}>{r.difference === null ? "—" : money(r.difference)}</td>
                </tr>
              </tbody>
            </table>
            {r.statementBalance !== null && (
              <div className="recon-save no-print">
                <input placeholder="Notes (optional)" value={notes} onChange={(e) => setNotes(e.target.value)} />
                <button className="btn" onClick={() => window.print()}>
                  <Icon name="print" size={16} /> Print / PDF
                </button>
                <button className="btn btn-primary" disabled={busy} onClick={save}>
                  {r.reconciled ? "Save Reconciliation" : "Save with Difference"}
                </button>
              </div>
            )}
          </div>

          {history.length > 0 && (
            <div className="card flush no-print">
              <h3 className="card-title">Past reconciliations</h3>
              <table className="table">
                <thead>
                  <tr>
                    <th>As of</th>
                    <th className="num">Bank</th>
                    <th className="num">Books</th>
                    <th className="num">Difference</th>
                    <th>Notes</th>
                    <th>Saved</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {history.map((h) => (
                    <tr key={h._id}>
                      <td>{date(h.asOf)}</td>
                      <td className="num">{money(h.statementBalance)}</td>
                      <td className="num">{money(h.bookBalance)}</td>
                      <td className={`num ${h.difference ? "text-overdue" : "text-paid"}`}>{h.difference ? money(h.difference) : "✓ 0.00"}</td>
                      <td>{h.notes}</td>
                      <td className="muted small">{date(h.createdAt)}</td>
                      <td>
                        <button
                          className="link-btn"
                          onClick={async () => {
                            await api.delete(`/banking/reconciliations/${h._id}`);
                            load();
                          }}
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/* ===================== Account statement page ===================== */
const STATUS_TABS = [
  ["unmatched", "To Do"],
  ["matched", "Matched"],
  ["categorized", "Categorised"],
  ["excluded", "Excluded"],
  ["all", "All"],
  ["reconcile", "Reconcile"],
];

export function BankAccountPage() {
  const { code } = useParams();
  const [acc, setAcc] = useState(null);
  const [accounts, setAccounts] = useState([]);
  const [lines, setLines] = useState(null);
  const [tab, setTab] = useState("unmatched");
  const [importOpen, setImportOpen] = useState(false);
  const [matchLine, setMatchLine] = useState(null);
  const [confirm, setConfirm] = useState(null);

  const loadAcc = () => api.get("/banking/accounts").then((r) => setAcc(r.data.find((a) => a.code === code) || null));
  const loadLines = () =>
    tab === "reconcile" ? Promise.resolve() : api.get(`/banking/${encodeURIComponent(code)}/lines`, { params: { status: tab } }).then((r) => setLines(r.data));
  const [version, setVersion] = useState(0);
  const reload = () => {
    loadAcc();
    loadLines();
    setVersion((v) => v + 1);
  };
  useEffect(() => {
    loadAcc();
    api.get("/accounts").then((r) => setAccounts(r.data));
  }, [code]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    setLines(null);
    loadLines();
  }, [code, tab]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!acc) return <Spinner />;
  const act = async (fn, msg) => {
    try {
      await fn();
      toast(msg);
      setConfirm(null);
      reload();
    } catch (e) {
      setConfirm(null);
      toast(errMsg(e), "error");
    }
  };

  return (
    <>
      <PageHeader title={acc.name} subtitle={`${acc.group}${acc.accountCode ? ` · ••${acc.accountCode.slice(-4)}` : ""}`} back="/banking">
        <Link to={`/chart-of-accounts/${encodeURIComponent(code)}`} className="btn">
          Transactions in MGI
        </Link>
        <button className="btn btn-primary" onClick={() => setImportOpen(true)}>
          <Icon name="plus" size={16} /> Import Statement
        </button>
      </PageHeader>

      <div className="card stat-row" style={{ marginBottom: 18 }}>
        <div>
          <span className="muted small">Balance in MGI</span>
          <strong className="big">{money(acc.balance)}</strong>
        </div>
        <div>
          <span className="muted small">
            {acc.statement.lastBalance !== null ? `Balance as per bank · ${date(acc.statement.lastBalanceDate)}` : "Net of imported statement lines"}
          </span>
          <strong className="big">{money(acc.statement.lastBalance !== null ? acc.statement.lastBalance : acc.statement.net)}</strong>
        </div>
        <div>
          <span className="muted small">Still to match or categorise</span>
          <strong className={`big ${acc.statement.unmatched ? "text-overdue" : "text-paid"}`}>{acc.statement.unmatched}</strong>
        </div>
      </div>

      <div className="tabs">
        {STATUS_TABS.map(([k, l]) => (
          <button key={k} className={`tab ${tab === k ? "active" : ""}`} onClick={() => setTab(k)}>
            {l}
          </button>
        ))}
      </div>

      {tab === "reconcile" ? (
        <Reconcile code={code} acc={acc} onChanged={() => loadAcc()} openLine={setMatchLine} version={version} />
      ) : !lines ? (
        <Spinner />
      ) : !lines.length ? (
        <Empty
          icon="bank"
          title={tab === "unmatched" ? (acc.statement.lines ? "All caught up" : "Import your bank statement") : "Nothing here"}
          text={
            tab === "unmatched" && !acc.statement.lines
              ? "Upload the CSV statement from your bank. MGI suggests matches with payments and expenses you've recorded, and you can categorise the rest in a click."
              : undefined
          }
          action={
            tab === "unmatched" && !acc.statement.lines ? (
              <button className="btn btn-primary" onClick={() => setImportOpen(true)}>
                Import Statement
              </button>
            ) : null
          }
        />
      ) : (
        <div className="card flush">
          {lines.some((l) => l.balanceMismatch) && (
            <div className="alert alert-error" style={{ margin: 12 }}>
              {lines.filter((l) => l.balanceMismatch).length} line(s) marked ⚠ don't follow from the previous balance. A transaction is probably missing from
              the imported file between those dates — import that period again.
            </div>
          )}
          <table className="table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Description</th>
                <th>Reference</th>
                <th className="num">Deposits</th>
                <th className="num">Withdrawals</th>
                <th className="num">Balance</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l._id}>
                  <td>{date(l.date)}</td>
                  <td className="clamp">{l.description}</td>
                  <td className="mono small">{l.reference}</td>
                  <td className="num text-paid">{l.deposit ? money(l.deposit) : ""}</td>
                  <td className="num">{l.withdrawal ? money(l.withdrawal) : ""}</td>
                  <td className={`num ${l.balanceMismatch ? "text-overdue" : "muted"}`} title={l.balanceMismatch ? `Expected ${money(l.expectedBalance)} from the previous line` : ""}>
                    {l.balance !== null && l.balance !== undefined ? (
                      <>
                        {l.balanceMismatch && "⚠ "}
                        {money(l.balance)}
                      </>
                    ) : (
                      ""
                    )}
                  </td>
                  <td>
                    {l.status === "unmatched" ? (
                      <Status value="unmatched" />
                    ) : l.match?.id ? (
                      <Link to={docLink(l.match.type, l.match.id)} className="small">
                        <Status value={l.status} /> {l.match.type} {l.match.number}
                      </Link>
                    ) : (
                      <Status value={l.status} />
                    )}
                  </td>
                  <td className="num nowrap">
                    {l.status === "unmatched" ? (
                      <>
                        <button className="btn btn-sm btn-primary" onClick={() => setMatchLine(l)}>
                          Match / Categorise
                        </button>{" "}
                        <button className="link-btn" onClick={() => act(() => api.post(`/banking/lines/${l._id}/exclude`), "Excluded")}>
                          Exclude
                        </button>
                      </>
                    ) : (
                      <button className="link-btn" onClick={() => (l.status === "categorized" ? setConfirm(l) : act(() => api.post(`/banking/lines/${l._id}/undo`), "Undone"))}>
                        Undo
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <ImportModal open={importOpen} account={acc} onClose={() => setImportOpen(false)} onDone={() => (setImportOpen(false), setTab("unmatched"), reload())} />
      <MatchModal line={matchLine} accounts={accounts} bankCode={code} onClose={() => setMatchLine(null)} onDone={() => (setMatchLine(null), reload())} />
      <Confirm
        open={!!confirm}
        title="Undo this categorisation?"
        text={`The ${confirm?.match?.type?.toLowerCase()} created from this line (${confirm?.match?.number}) will be deleted.`}
        confirmLabel="Undo"
        onConfirm={() => act(() => api.post(`/banking/lines/${confirm._id}/undo`), "Undone")}
        onCancel={() => setConfirm(null)}
      />
    </>
  );
}
