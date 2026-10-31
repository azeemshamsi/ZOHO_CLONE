import { useEffect, useState } from "react";
import api from "../lib/api";
import { Field } from "./ui";

let cache = null;
export const clearBankAccountCache = () => {
  cache = null;
};

// Pick the cash/bank account money goes into or comes out of.
// Blank = automatic: "Cash in Hand" for cash, "Bank Account" for everything else.
export default function BankAccountSelect({ label = "Deposit To", value, onChange, mode }) {
  const [accounts, setAccounts] = useState(cache || []);
  useEffect(() => {
    if (cache) return;
    api.get("/banking/accounts").then((r) => {
      cache = r.data;
      setAccounts(r.data);
    });
  }, []);
  const auto = mode === "cash" ? "Cash in Hand" : "Bank Account";
  return (
    <Field label={label}>
      <select value={value || ""} onChange={(e) => onChange(e.target.value)}>
        <option value="">Automatic ({auto})</option>
        {accounts.map((a) => (
          <option key={a.code} value={a.code}>
            {a.name}
          </option>
        ))}
      </select>
    </Field>
  );
}
