import { useEffect, useState } from "react";
import api, { errMsg } from "../lib/api";
import { Modal, Field, toast } from "./ui";
import { browserOf } from "../pages/Security";

// Shown when Amazon order data is refused because this browser isn't an approved device.
export default function DeviceGate() {
  const [info, setInfo] = useState(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  useEffect(() => {
    const on = (e) => {
      setInfo(e.detail || {});
      setSent(!!e.detail?.details?.requested);
    };
    window.addEventListener("ordexago:device-blocked", on);
    return () => window.removeEventListener("ordexago:device-blocked", on);
  }, []);
  if (!info) return null;
  const request = async () => {
    setBusy(true);
    try {
      const { data } = await api.post("/security/devices/request", { name: name || browserOf(navigator.userAgent) });
      if (data.approved) toast("This device is already approved — try again");
      setSent(true);
    } catch (e) {
      toast(errMsg(e), "error");
    }
    setBusy(false);
  };
  return (
    <Modal
      open
      title="Device not approved"
      onClose={() => setInfo(null)}
      footer={
        <>
          <button className="btn" onClick={() => setInfo(null)}>
            Close
          </button>
          {!sent && (
            <button className="btn btn-primary" disabled={busy} onClick={request}>
              {busy ? "Sending…" : "Request approval"}
            </button>
          )}
        </>
      }
    >
      <p>{info.message || "This device isn't approved for Amazon order data — ask your admin to approve it"}.</p>
      {sent ? (
        <div className="alert alert-success">Approval requested. Your admin has been emailed; once they approve this device in Settings → Security → Devices, try again.</div>
      ) : (
        <Field label="Name this device" hint="So your admin knows which one it is, e.g. “Packing desk PC”">
          <input value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder={browserOf(navigator.userAgent)} />
        </Field>
      )}
    </Modal>
  );
}
