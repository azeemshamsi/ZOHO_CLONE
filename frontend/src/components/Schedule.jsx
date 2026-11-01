import { Field } from "./ui";
import Icon from "./Icon";
import { isoDate } from "../lib/format";

export const UNITS = [
  ["day", "Day(s)", "Daily"],
  ["week", "Week(s)", "Weekly"],
  ["month", "Month(s)", "Monthly"],
  ["year", "Year(s)", "Yearly"],
];
export const freqLabel = (p) => (Number(p.every) === 1 ? UNITS.find((u) => u[0] === p.unit)[2] : `Every ${p.every} ${UNITS.find((u) => u[0] === p.unit)[1].replace("(s)", "s")}`);

// Profile name, repeat every, start and end — for recurring expenses.
export function ScheduleFields({ sched, onChange }) {
  const set = (k, v) => onChange({ ...sched, [k]: v });
  return (
    <>
      <Field label="Profile Name" required>
        <input required value={sched.name} onChange={(e) => set("name", e.target.value)} placeholder="e.g. Office rent" />
      </Field>
      <div className="row-3">
        <Field label="Repeat Every" required>
          <div className="inline-add">
            <input type="number" min="1" max="365" required value={sched.every} onChange={(e) => set("every", e.target.value)} style={{ width: 80 }} />
            <select value={sched.unit} onChange={(e) => set("unit", e.target.value)}>
              {UNITS.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </div>
        </Field>
        <Field label="Start On" required hint={sched.startDate < isoDate() ? "Past dates are created straight away" : ""}>
          <input type="date" required value={sched.startDate} onChange={(e) => set("startDate", e.target.value)} />
        </Field>
        <Field label="Ends On">
          {sched.never ? (
            <label className="check">
              <input type="checkbox" checked onChange={() => set("never", false)} /> Never expires
            </label>
          ) : (
            <div className="inline-add">
              <input type="date" required value={sched.endDate} min={sched.startDate} onChange={(e) => set("endDate", e.target.value)} />
              <button type="button" className="btn btn-sm" title="Never expires" onClick={() => onChange({ ...sched, never: true, endDate: "" })}>
                <Icon name="x" size={14} />
              </button>
            </div>
          )}
        </Field>
      </div>
    </>
  );
}
