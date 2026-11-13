import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import api, { errMsg } from "../lib/api";
import { money } from "../lib/format";
import { STATES } from "../lib/constants";
import { uploadProof } from "../components/PaymentProofs";
import {
  PageHeader,
  Field,
  useDebounced,
  useClickAway,
  toast,
} from "../components/ui";

// Store → Orders → New order: an order taken on the phone / WhatsApp / Instagram, created in Shopify (as a draft
// order, then completed), so it gets a Shopify order number, takes stock and comes back into Store → Orders.

const EMPTY_ADDR = {
  name: "",
  company: "",
  address1: "",
  address2: "",
  city: "",
  state: "",
  zip: "",
  phone: "",
};
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const waNumber = (p) => {
  const d = String(p || "").replace(/\D/g, "");
  return d.length === 10 ? `91${d}` : d.replace(/^0+/, "");
};

// Live search against Shopify; shows results under the box and calls onPick.
function LiveSearch({
  path,
  placeholder,
  render,
  onPick,
  minLength = 0,
  autoFocus,
}) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState([]);
  const [busy, setBusy] = useState(false);
  const dq = useDebounced(q, 300);
  const ref = useClickAway(open, () => setOpen(false));
  useEffect(() => {
    if (!open || dq.trim().length < minLength) {
      setRows([]);
      return undefined;
    }
    let live = true;
    setBusy(true);
    api
      .get(path, { params: { q: dq } })
      .then((r) => live && setRows(r.data))
      .catch((e) => live && (toast(errMsg(e), "error"), setRows([])))
      .finally(() => live && setBusy(false));
    return () => {
      live = false;
    };
  }, [dq, open]);
  return (
    <div ref={ref} style={{ position: "relative" }}>
      <input
        value={q}
        autoFocus={autoFocus}
        placeholder={placeholder}
        onFocus={() => setOpen(true)}
        onChange={(e) => (setQ(e.target.value), setOpen(true))}
      />
      {open &&
        (busy ||
          rows.length > 0 ||
          dq.trim().length >= Math.max(1, minLength)) && (
          <div
            className="dropdown"
            style={{
              left: 0,
              right: 0,
              top: "calc(100% + 4px)",
              maxHeight: 340,
              overflowY: "auto",
            }}
          >
            {busy && !rows.length && (
              <div className="muted small pad">Searching Shopify…</div>
            )}
            {!busy && !rows.length && (
              <div className="muted small pad">Nothing found</div>
            )}
            {rows.map((r, i) => (
              <button
                type="button"
                key={i}
                onClick={() => {
                  onPick(r);
                  setQ("");
                  setOpen(false);
                }}
              >
                {render(r)}
              </button>
            ))}
          </div>
        )}
    </div>
  );
}

export default function NewStoreOrder() {
  const nav = useNavigate();
  const [customerId, setCustomerId] = useState(null);
  const [customer, setCustomer] = useState({ name: "", email: "", phone: "" });
  const [addr, setAddr] = useState(EMPTY_ADDR);
  const [lines, setLines] = useState([]);
  const [shipping, setShipping] = useState({ title: "Shipping", amount: 0 });
  const [discount, setDiscount] = useState({
    type: "amount",
    value: 0,
    reason: "",
  });
  const [payment, setPayment] = useState("cod");
  const [note, setNote] = useState("");
  const [proofs, setProofs] = useState([]);
  const [proofRef, setProofRef] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);

  const setA = (k) => (e) => setAddr({ ...addr, [k]: e.target.value });
  const setC = (k) => (e) => setCustomer({ ...customer, [k]: e.target.value });
  const pickCustomer = (c) => {
    setCustomerId(c.id);
    setCustomer({ name: c.name, email: c.email, phone: c.phone });
    setAddr({
      ...EMPTY_ADDR,
      ...c.address,
      name: c.address.name || c.name,
      phone: c.address.phone || c.phone,
    });
  };
  const addProduct = (p) => {
    const at = lines.findIndex((l) => l.variantId === p.variantId);
    if (at >= 0)
      setLines(
        lines.map((l, i) =>
          i === at ? { ...l, quantity: l.quantity + 1 } : l,
        ),
      );
    else setLines([...lines, { ...p, quantity: 1, basePrice: p.price }]);
  };
  const setLine = (i, k, v) =>
    setLines(lines.map((l, j) => (j === i ? { ...l, [k]: v } : l)));

  const sub = r2(
    lines.reduce(
      (t, l) => t + (Number(l.price) || 0) * (Number(l.quantity) || 0),
      0,
    ),
  );
  const disc =
    discount.type === "percent"
      ? r2((sub * (Number(discount.value) || 0)) / 100)
      : r2(Number(discount.value) || 0);
  const total = r2(sub - disc + (Number(shipping.amount) || 0));

  const submit = async (e) => {
    e.preventDefault();
    if (!lines.length) return toast("Add at least one product", "error");
    if (!customer.phone && !addr.phone)
      return toast("Enter the customer's phone number", "error");
    setBusy(true);
    try {
      const { data } = await api.post("/shopify/new-order", {
        customerId,
        customer: { ...customer, name: customer.name || addr.name },
        address: { ...addr, phone: addr.phone || customer.phone },
        lines: lines.map((l) => ({
          variantId: l.variantId,
          quantity: Number(l.quantity),
          price: Number(l.price),
          basePrice: l.basePrice,
        })),
        shipping: {
          title: shipping.title,
          amount: Number(shipping.amount) || 0,
        },
        discount: { ...discount, value: Number(discount.value) || 0 },
        payment,
        note,
      });
      if (data.order) {
        toast(`Order ${data.order.name} created in Shopify`);
        if (payment === "paid" && proofs.length) {
          if (!data.order.id)
            toast(
              "Order created, but it isn't in OrdexaGo yet — add the payment screenshot from the order after the next sync",
              "error",
            );
          for (const f of data.order.id ? proofs : []) {
            try {
              const p = await uploadProof(data.order.id, f, proofRef.trim());
              if (p.error) toast(p.error, "error");
            } catch (e) {
              toast(errMsg(e), "error");
            }
          }
        }
        nav(
          data.order.id
            ? `/shopify-orders?tab=new&q=${encodeURIComponent(data.order.name)}`
            : "/shopify-orders?tab=new",
        );
      } else setDone(data.draft);
    } catch (err) {
      toast(errMsg(err), "error");
    }
    setBusy(false);
  };

  if (done) {
    const phone = addr.phone || customer.phone;
    const text = `Hi ${(customer.name || addr.name).split(" ")[0]}, here is the link to pay for your order of ${money(done.total)}: ${done.url}`;
    return (
      <>
        <PageHeader title="Payment link ready" />
        <div className="card" style={{ maxWidth: 640 }}>
          <p>
            Draft <strong>{done.name}</strong> is in Shopify for{" "}
            {money(done.total)}. Send the customer this link; the order is
            created as soon as they pay, and comes into Store → Orders with the
            next sync.
          </p>
          <input readOnly value={done.url} onFocus={(e) => e.target.select()} />
          <div
            style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}
          >
            {phone && (
              <a
                className="btn btn-primary"
                href={`https://wa.me/${waNumber(phone)}?text=${encodeURIComponent(text)}`}
                target="_blank"
                rel="noreferrer"
              >
                Send on WhatsApp
              </a>
            )}
            {customer.email && (
              <a
                className="btn"
                href={`mailto:${customer.email}?subject=${encodeURIComponent("Your order")}&body=${encodeURIComponent(text)}`}
              >
                Email
              </a>
            )}
            <button
              className="btn"
              onClick={() =>
                navigator.clipboard
                  ?.writeText(done.url)
                  .then(() => toast("Link copied"))
              }
            >
              Copy link
            </button>
            <button
              className="btn btn-ghost"
              onClick={() => nav("/shopify-orders")}
            >
              Back to orders
            </button>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="New order"
        subtitle="Created in Shopify with the next Shopify order number, then shown in Store → Orders"
      />
      <form className="form" onSubmit={submit}>
        <div className="card" style={{ marginBottom: 16 }}>
          <h4 className="section-title" style={{ marginTop: 0 }}>
            Products
          </h4>
          <LiveSearch
            path="/shopify/new-order/products"
            placeholder="Search Shopify products by name or SKU…"
            render={(p) => (
              <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
                {p.image ? (
                  <img
                    src={p.image}
                    alt=""
                    width={34}
                    height={34}
                    style={{ objectFit: "cover", borderRadius: 4 }}
                  />
                ) : (
                  <span style={{ width: 34 }} />
                )}
                <span style={{ flex: 1 }}>
                  {p.title}
                  {p.variant ? ` — ${p.variant}` : ""}
                  <div className="muted small">
                    {p.sku || "no SKU"} · {money(p.price)}
                    {p.stock != null ? ` · ${p.stock} in stock` : ""}
                  </div>
                </span>
              </span>
            )}
            onPick={addProduct}
          />
          {lines.length > 0 && (
            <table className="table" style={{ marginTop: 12 }}>
              <thead>
                <tr>
                  <th>Product</th>
                  <th className="num" style={{ width: 90 }}>
                    Qty
                  </th>
                  <th className="num" style={{ width: 120 }}>
                    Price
                  </th>
                  <th className="num">Amount</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {lines.map((l, i) => (
                  <tr key={l.variantId}>
                    <td data-label="Product">
                      {l.title}
                      {l.variant ? ` — ${l.variant}` : ""}
                      <div className="muted small">
                        {l.sku}
                        {l.stock != null && l.stock < l.quantity ? (
                          <span className="text-red">
                            {" "}
                            · only {l.stock} in stock
                          </span>
                        ) : (
                          ""
                        )}
                        {Number(l.price) !== Number(l.basePrice)
                          ? ` · list price ${money(l.basePrice)}`
                          : ""}
                      </div>
                    </td>
                    <td data-label="Qty" className="num">
                      <input
                        type="number"
                        min="1"
                        value={l.quantity}
                        onChange={(e) => setLine(i, "quantity", e.target.value)}
                        style={{ width: 70 }}
                      />
                    </td>
                    <td data-label="Price" className="num">
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        value={l.price}
                        onChange={(e) => setLine(i, "price", e.target.value)}
                        style={{ width: 100 }}
                      />
                    </td>
                    <td data-label="Amount" className="num">
                      {money(
                        (Number(l.price) || 0) * (Number(l.quantity) || 0),
                      )}
                    </td>
                    <td>
                      <button
                        type="button"
                        className="btn btn-sm btn-ghost"
                        onClick={() =>
                          setLines(lines.filter((_, j) => j !== i))
                        }
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="card" style={{ marginBottom: 16 }}>
          <h4 className="section-title" style={{ marginTop: 0 }}>
            Customer
            {customerId && (
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={() => (
                  setCustomerId(null),
                  setCustomer({ name: "", email: "", phone: "" }),
                  setAddr(EMPTY_ADDR)
                )}
              >
                Clear
              </button>
            )}
          </h4>
          {!customerId && (
            <div style={{ marginBottom: 12 }}>
              <LiveSearch
                path="/shopify/new-order/customers"
                minLength={2}
                placeholder="Existing customer? Search by name, phone or email…"
                render={(c) => (
                  <span>
                    <strong>{c.name || "—"}</strong>{" "}
                    {c.orders > 0 && (
                      <span className="muted small">· {c.orders} orders</span>
                    )}
                    <div className="muted small">
                      {[c.phone, c.email, c.address.city]
                        .filter(Boolean)
                        .join(" · ")}
                    </div>
                  </span>
                )}
                onPick={pickCustomer}
              />
              <div className="muted small" style={{ marginTop: 4 }}>
                Or type a new customer below — Shopify adds them as a customer.
              </div>
            </div>
          )}
          <div className="form-grid">
            <div className="row-2">
              <Field label="Phone" required>
                <input
                  value={customer.phone}
                  onChange={setC("phone")}
                  inputMode="tel"
                  placeholder="10-digit mobile"
                />
              </Field>
              <Field
                label="Email"
                hint="Shopify sends the order confirmation here"
              >
                <input
                  type="email"
                  value={customer.email}
                  onChange={setC("email")}
                />
              </Field>
            </div>
          </div>
          <h4 className="section-title">Delivery address</h4>
          <div className="form-grid">
            <div className="row-2">
              <Field label="Name" required>
                <input value={addr.name} onChange={setA("name")} required />
              </Field>
              <Field
                label="Phone at the address"
                hint="Leave blank to use the customer's phone"
              >
                <input
                  value={addr.phone}
                  onChange={setA("phone")}
                  inputMode="tel"
                />
              </Field>
            </div>
            <Field label="Address line 1" required>
              <input
                value={addr.address1}
                onChange={setA("address1")}
                required
              />
            </Field>
            <Field label="Address line 2 / landmark">
              <input value={addr.address2} onChange={setA("address2")} />
            </Field>
            <div className="row-2">
              <Field label="City" required>
                <input value={addr.city} onChange={setA("city")} required />
              </Field>
              <Field label="Pincode" required>
                <input
                  value={addr.zip}
                  onChange={setA("zip")}
                  inputMode="numeric"
                  pattern="\d{6}"
                  maxLength={6}
                  required
                />
              </Field>
            </div>
            <div className="row-2">
              <Field label="State" required>
                <select value={addr.state} onChange={setA("state")} required>
                  <option value="">Choose…</option>
                  {STATES.filter(([c]) => c !== "97").map(([c, n]) => (
                    <option key={c} value={c}>
                      {n}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Company (optional)">
                <input value={addr.company} onChange={setA("company")} />
              </Field>
            </div>
          </div>
        </div>

        <div className="card" style={{ marginBottom: 16 }}>
          <h4 className="section-title" style={{ marginTop: 0 }}>
            Payment
          </h4>
          <div className="form-grid">
            <label className="check">
              <input
                type="radio"
                name="pay"
                checked={payment === "cod"}
                onChange={() => setPayment("cod")}
              />{" "}
              Cash on delivery — order created now, payment pending
            </label>
            <label className="check">
              <input
                type="radio"
                name="pay"
                checked={payment === "paid"}
                onChange={() => setPayment("paid")}
              />{" "}
              Already paid (UPI / bank transfer) — order created now and marked
              paid
            </label>
            {payment === "paid" && (
              <div
                className="card pad"
                style={{ display: "grid", gap: 6 }}
                onPaste={(e) =>
                  e.clipboardData?.files?.length &&
                  setProofs([...proofs, ...e.clipboardData.files])
                }
              >
                <div className="small">
                  Payment screenshot (optional) — saved with the order and added
                  to the Shopify order. You can also paste a screenshot here.
                </div>
                <div
                  style={{
                    display: "flex",
                    gap: 6,
                    flexWrap: "wrap",
                    alignItems: "center",
                  }}
                >
                  <input
                    placeholder="UTR / reference"
                    value={proofRef}
                    onChange={(e) => setProofRef(e.target.value)}
                    style={{ maxWidth: 220 }}
                  />
                  <label className="btn btn-sm">
                    + Add screenshot
                    <input
                      type="file"
                      hidden
                      multiple
                      accept="image/*,application/pdf"
                      onChange={(e) => (
                        setProofs([...proofs, ...e.target.files]),
                        (e.target.value = "")
                      )}
                    />
                  </label>
                </div>
                {proofs.map((f, i) => (
                  <div key={i} className="small">
                    {f.name} ·{" "}
                    <button
                      type="button"
                      className="link-btn"
                      onClick={() =>
                        setProofs(proofs.filter((_, j) => j !== i))
                      }
                    >
                      remove
                    </button>
                  </div>
                ))}
              </div>
            )}
            <label className="check">
              <input
                type="radio"
                name="pay"
                checked={payment === "link"}
                onChange={() => setPayment("link")}
              />{" "}
              Send a payment link — the order is created when the customer pays
              online
            </label>
            <div className="row-2">
              <Field label="Shipping charge">
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={shipping.amount}
                  onChange={(e) =>
                    setShipping({ ...shipping, amount: e.target.value })
                  }
                />
              </Field>
              <Field label="Discount">
                <div style={{ display: "flex", gap: 6 }}>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={discount.value}
                    onChange={(e) =>
                      setDiscount({ ...discount, value: e.target.value })
                    }
                  />
                  <select
                    value={discount.type}
                    onChange={(e) =>
                      setDiscount({ ...discount, type: e.target.value })
                    }
                    style={{ width: 80 }}
                  >
                    <option value="amount">₹</option>
                    <option value="percent">%</option>
                  </select>
                </div>
              </Field>
            </div>
            <Field label="Note (shows on the Shopify order)">
              <textarea
                rows={2}
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            </Field>
          </div>
          <div style={{ marginTop: 12, textAlign: "right" }}>
            <div className="muted small">
              Items {money(sub)}
              {disc ? ` − discount ${money(disc)}` : ""}
              {Number(shipping.amount)
                ? ` + shipping ${money(shipping.amount)}`
                : ""}
            </div>
            <div style={{ fontSize: 20, fontWeight: 600 }}>{money(total)}</div>
            <div className="muted small">
              Taxes are worked out by Shopify as on your store (prices including
              GST stay as they are).
            </div>
          </div>
        </div>

        <div className="form-actions">
          <button className="btn btn-primary" disabled={busy || !lines.length}>
            {busy
              ? "Creating in Shopify…"
              : payment === "link"
                ? "Create & get payment link"
                : "Create order"}
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => nav("/shopify-orders")}
          >
            Cancel
          </button>
        </div>
      </form>
    </>
  );
}
