import { Fragment, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import api, { errMsg } from "../lib/api";
import { STATES, stateName } from "../lib/constants";
import { money, date, isoDate } from "../lib/format";
import {
  PageHeader,
  Spinner,
  Empty,
  Field,
  Modal,
  Confirm,
  SearchBox,
  toast,
} from "../components/ui";
import Icon from "../components/Icon";

// Store → Sellers: marketplace sellers (brands on the Shopify store), their logins, pickup addresses with couriers,
// penalties and the monthly purchase orders for delivered orders.

const prevMonth = () => {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};
const COURIER_STATUS = {
  registered: "Registered",
  exists: "Already there",
  entered: "Entered by hand",
  per_booking: "Sent with each booking",
  address_changed: "Address changed — register again",
};

export default function Sellers() {
  const [tab, setTab] = useState(
    () => new URLSearchParams(window.location.search).get("tab") || "sellers",
  );
  const [reviewCount, setReviewCount] = useState(0);
  const [sellers, setSellers] = useState(null);
  const load = () =>
    api
      .get("/sellers")
      .then((r) => setSellers(r.data))
      .catch((e) => toast(errMsg(e), "error"));
  useEffect(() => {
    load();
    api
      .get("/seller-listings", { params: { status: "draft" } })
      .then((r) => setReviewCount(r.data.counts.draft || 0))
      .catch(() => {});
  }, []);
  const pendingCount = (sellers || []).filter(
    (s) => s.status === "pending",
  ).length;
  const approved = (sellers || []).filter(
    (s) => !s.status || s.status === "approved",
  );
  return (
    <>
      <PageHeader
        title="Sellers"
        subtitle="Marketplace sellers on your Shopify store: their orders, pickups, deductions and monthly purchase orders"
      />
      <div className="tabs">
        {[
          ["sellers", "Sellers"],
          ["registrations", "Registrations", pendingCount],
          ["listings", "Listings", reviewCount],
          ["penalties", "Deductions"],
          ["pos", "Monthly purchase orders"],
        ].map(([k, l, n]) => (
          <button
            key={k}
            className={`tab ${tab === k ? "active" : ""}`}
            onClick={() => setTab(k)}
          >
            {l}
            {n > 0 && <span className="tab-count red">{n}</span>}
          </button>
        ))}
      </div>
      {!sellers ? (
        <Spinner />
      ) : tab === "sellers" ? (
        <SellerList sellers={approved} reload={load} />
      ) : tab === "registrations" ? (
        <Registrations sellers={sellers} reload={load} />
      ) : tab === "listings" ? (
        <Listings sellers={approved} onCount={setReviewCount} />
      ) : tab === "penalties" ? (
        <Penalties sellers={approved} onChanged={load} />
      ) : (
        <MonthlyPos sellers={approved} />
      )}
    </>
  );
}

/* ======================= Sellers ======================= */
function SellerList({ sellers, reload }) {
  const [q, setQ] = useState("");
  const [form, setForm] = useState(null);
  const [open, setOpen] = useState(null);
  const t = q.trim().toLowerCase();
  const rows = sellers.filter(
    (s) =>
      !t ||
      [
        s.name,
        s.contactName,
        s.email,
        s.phone,
        s.gstin,
        ...(s.brands || []),
      ].some((x) =>
        String(x || "")
          .toLowerCase()
          .includes(t),
      ),
  );
  return (
    <>
      <div
        style={{
          display: "flex",
          gap: 8,
          alignItems: "center",
          flexWrap: "wrap",
          marginBottom: 12,
        }}
      >
        <SearchBox
          value={q}
          onChange={setQ}
          placeholder="Search seller, brand, GSTIN"
        />
        <div style={{ flex: 1 }} />
        <button className="btn btn-primary" onClick={() => setForm({})}>
          <Icon name="plus" size={16} /> New seller
        </button>
      </div>
      {!rows.length ? (
        <Empty
          title={sellers.length ? "No sellers match" : "No sellers yet"}
          text="Add a seller with their brand names exactly as in the Shopify product's Vendor field. Their orders are then tagged, picked up from their address and paid through a purchase order every month."
        />
      ) : (
        <div className="card" style={{ padding: 0, overflowX: "auto" }}>
          <table className="table table-click">
            <thead>
              <tr>
                <th>Seller</th>
                <th>Brands</th>
                <th className="num">Rate</th>
                <th>Pickup</th>
                <th className="num">Open orders</th>
                <th className="num">Delivered, not on a PO</th>
                <th className="num">Deductions due</th>
                <th className="num">Logins</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr
                  key={s._id}
                  onClick={() => setOpen(s._id)}
                  style={s.active === false ? { opacity: 0.55 } : undefined}
                >
                  <td>
                    <div className="strong">
                      {s.name}{" "}
                      {s.active === false && (
                        <span className="status status-cancelled">
                          Inactive
                        </span>
                      )}
                    </div>
                    <div className="small muted">
                      {[s.contactName, s.phone, s.gstin]
                        .filter(Boolean)
                        .join(" · ")}
                    </div>
                  </td>
                  <td className="small">{(s.brands || []).join(", ")}</td>
                  <td className="num">{s.rate}%</td>
                  <td className="small">
                    {s.pickup?.pincode ? (
                      `${s.pickup.city || ""} ${s.pickup.pincode}`
                    ) : (
                      <span className="muted">Not set</span>
                    )}
                  </td>
                  <td className="num">{s.stats.open}</td>
                  <td className="num">{s.stats.deliveredUnsettled}</td>
                  <td className="num">
                    {s.stats.penaltiesPending
                      ? money(s.stats.penaltiesPending)
                      : "—"}
                  </td>
                  <td className="num">{s.stats.logins}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {form && (
        <SellerForm
          seller={form}
          onClose={() => setForm(null)}
          onSaved={(id) => {
            setForm(null);
            reload();
            if (id) setOpen(id);
          }}
        />
      )}
      {open && (
        <SellerDetail
          id={open}
          onClose={() => setOpen(null)}
          onEdit={(s) => {
            setOpen(null);
            setForm(s);
          }}
          onChanged={reload}
        />
      )}
    </>
  );
}

function SellerForm({ seller, onClose, onSaved }) {
  const isNew = !seller._id;
  const [f, setF] = useState(() => ({
    name: seller.name || "",
    brands: seller.brands || [],
    rate: seller.rate ?? "",
    poFrom: seller.poFrom ? isoDate(seller.poFrom) : "",
    contactName: seller.contactName || "",
    email: seller.email || "",
    phone: seller.phone || "",
    gstin: seller.gstin || "",
    pan: seller.pan || "",
    pickup: {
      name: "",
      phone: "",
      address: "",
      city: "",
      state: "",
      pincode: "",
      ...(seller.pickup || {}),
    },
    active: seller.active !== false,
    notes: seller.notes || "",
  }));
  const [brand, setBrand] = useState("");
  const [known, setKnown] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    api
      .get("/sellers/brands")
      .then((r) => setKnown(r.data))
      .catch(() => {});
  }, []);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const setP = (k) => (e) =>
    setF({ ...f, pickup: { ...f.pickup, [k]: e.target.value } });
  const addBrand = (b) => {
    const v = (b ?? brand).trim();
    if (v && !f.brands.some((x) => x.toLowerCase() === v.toLowerCase()))
      setF({ ...f, brands: [...f.brands, v], name: f.name || v });
    setBrand("");
  };
  const free = known.filter(
    (k) =>
      (!k.seller || k.seller === seller.name) &&
      !f.brands.some((b) => b.toLowerCase() === k.brand.toLowerCase()),
  );
  const save = async () => {
    setBusy(true);
    setError("");
    try {
      const body = {
        ...f,
        poFrom: f.poFrom || null,
        brands: brand.trim() ? [...f.brands, brand.trim()] : f.brands,
        rate: Number(f.rate),
      };
      const { data } = isNew
        ? await api.post("/sellers", body)
        : await api.put(`/sellers/${seller._id}`, body);
      toast(
        `${body.name} saved${data.ordersTagged ? ` · ${data.ordersTagged} orders tagged` : ""}${data.addressChanged ? " · register the new pickup address with the couriers" : ""}`,
      );
      onSaved(isNew ? data.seller._id : seller._id);
    } catch (e) {
      setError(errMsg(e));
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      wide
      title={isNew ? "New seller" : `Edit ${seller.name}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            disabled={
              busy ||
              !f.name.trim() ||
              !(f.brands.length || brand.trim()) ||
              f.rate === ""
            }
            onClick={save}
          >
            {busy ? "Saving…" : "Save"}
          </button>
        </>
      }
    >
      <div className="form-grid">
        <Field
          label="Brands"
          required
          hint="Exactly as the Vendor on the seller's Shopify products. Orders with these products are this seller's."
        >
          <div
            style={{
              display: "flex",
              gap: 6,
              flexWrap: "wrap",
              marginBottom: f.brands.length ? 6 : 0,
            }}
          >
            {f.brands.map((b) => (
              <span key={b} className="chip">
                {b}
                <button
                  type="button"
                  className="link-btn"
                  onClick={() =>
                    setF({ ...f, brands: f.brands.filter((x) => x !== b) })
                  }
                  aria-label={`Remove ${b}`}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <input
              list="seller-brands"
              value={brand}
              onChange={(e) => setBrand(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addBrand();
                }
              }}
              placeholder="Type or pick a Shopify vendor"
            />
            <button type="button" className="btn" onClick={() => addBrand()}>
              Add
            </button>
          </div>
          <datalist id="seller-brands">
            {free.map((k) => (
              <option key={k.brand} value={k.brand}>
                {k.orders} orders
              </option>
            ))}
          </datalist>
        </Field>
        <div className="row-3">
          <Field label="Seller name" required>
            <input value={f.name} onChange={set("name")} />
          </Field>
          <Field
            label="Purchase rate %"
            required
            hint="Of the sale price incl. GST, before your discounts"
          >
            <input
              type="number"
              min="0"
              max="100"
              step="0.01"
              value={f.rate}
              onChange={set("rate")}
            />
          </Field>
          <Field label="Status">
            <select
              value={f.active ? "1" : "0"}
              onChange={(e) => setF({ ...f, active: e.target.value === "1" })}
            >
              <option value="1">Active</option>
              <option value="0">Inactive</option>
            </select>
          </Field>
        </div>
        <Field
          label="Purchase orders from"
          hint="Only orders delivered on or after this date go on purchase orders (earlier ones were settled outside OrdexaGo). Blank for a new seller = 1st of last month."
        >
          <input
            type="date"
            value={f.poFrom}
            onChange={set("poFrom")}
            style={{ maxWidth: 220 }}
          />
        </Field>
        <div className="row-3">
          <Field label="Contact person">
            <input value={f.contactName} onChange={set("contactName")} />
          </Field>
          <Field label="Email">
            <input type="email" value={f.email} onChange={set("email")} />
          </Field>
          <Field label="Phone">
            <input value={f.phone} onChange={set("phone")} />
          </Field>
        </div>
        <div className="row-2">
          <Field
            label="GSTIN"
            hint="With a GSTIN the purchase order carries GST; without, it's at 0%"
          >
            <input
              value={f.gstin}
              maxLength={15}
              onChange={(e) =>
                setF({ ...f, gstin: e.target.value.toUpperCase() })
              }
            />
          </Field>
          <Field label="PAN">
            <input
              value={f.pan}
              maxLength={10}
              onChange={(e) =>
                setF({ ...f, pan: e.target.value.toUpperCase() })
              }
            />
          </Field>
        </div>
        <div className="label-sm">
          Pickup address (couriers collect this seller's orders here)
        </div>
        <div className="row-2">
          <Field label="Pickup contact name">
            <input
              value={f.pickup.name}
              onChange={setP("name")}
              placeholder={f.contactName || f.name}
            />
          </Field>
          <Field label="Pickup phone" required>
            <input
              value={f.pickup.phone}
              onChange={setP("phone")}
              placeholder={f.phone}
            />
          </Field>
        </div>
        <Field label="Address" required>
          <textarea
            rows={2}
            value={f.pickup.address}
            onChange={setP("address")}
            placeholder="Building, street, area"
          />
        </Field>
        <div className="row-3">
          <Field label="City" required>
            <input value={f.pickup.city} onChange={setP("city")} />
          </Field>
          <Field label="State" required>
            <select value={f.pickup.state} onChange={setP("state")}>
              <option value="">Choose</option>
              {STATES.map(([c, n]) => (
                <option key={c} value={c}>
                  {n}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Pincode" required>
            <input
              value={f.pickup.pincode}
              maxLength={6}
              onChange={setP("pincode")}
            />
          </Field>
        </div>
        <Field label="Notes">
          <textarea rows={2} value={f.notes} onChange={set("notes")} />
        </Field>
        {error && <div className="alert alert-error">{error}</div>}
      </div>
    </Modal>
  );
}

function SellerDetail({ id, onClose, onEdit, onChanged }) {
  const [s, setS] = useState(null);
  const [addLogin, setAddLogin] = useState(false);
  const [invite, setInvite] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [busyAcc, setBusyAcc] = useState("");
  const [codes, setCodes] = useState(null); // courier row being edited
  const [pending, setPending] = useState(false);
  const load = () =>
    api
      .get(`/sellers/${id}`)
      .then((r) => setS(r.data))
      .catch((e) => toast(errMsg(e), "error"));
  useEffect(() => {
    load();
  }, [id]);
  const changed = () => {
    load();
    onChanged();
  };
  const register = async (acc) => {
    setBusyAcc(acc);
    try {
      const { data } = await api.post(
        `/sellers/${id}/couriers/${acc}/register`,
      );
      toast(
        data.pickupLocation
          ? `Registered as "${data.pickupLocation}"${data.note ? ` — ${data.note}` : ""}`
          : data.note || "Done",
      );
      load();
    } catch (e) {
      toast(errMsg(e), "error");
      load();
    }
    setBusyAcc("");
  };
  const removeLogin = async (uid) => {
    try {
      await api.delete(`/sellers/${id}/users/${uid}`);
      toast("Login removed");
      changed();
    } catch (e) {
      toast(errMsg(e), "error");
    }
    setConfirm(null);
  };
  const remove = async () => {
    try {
      await api.delete(`/sellers/${id}`);
      toast("Seller deleted");
      onChanged();
      onClose();
    } catch (e) {
      toast(errMsg(e), "error");
      setConfirm(null);
    }
  };
  return (
    <Modal open wide title={s ? s.name : "Seller"} onClose={onClose}>
      {!s ? (
        <Spinner />
      ) : (
        <div className="form-grid">
          <div
            style={{
              display: "flex",
              gap: 8,
              flexWrap: "wrap",
              alignItems: "center",
            }}
          >
            <span className="small muted">
              Brands: <strong>{s.brands.join(", ")}</strong> · Rate{" "}
              <strong>{s.rate}%</strong>
            </span>
            <div style={{ flex: 1 }} />
            <button className="btn btn-sm" onClick={() => setPending(true)}>
              Next PO / exclude orders
            </button>
            <Link
              className="btn btn-sm"
              to={`/shopify-orders?seller=${s._id}`}
              onClick={onClose}
            >
              Orders
            </Link>
            <button className="btn btn-sm" onClick={() => onEdit(s)}>
              <Icon name="edit" size={14} /> Edit
            </button>
            <button
              className="icon-btn"
              title="Delete"
              onClick={() => setConfirm({ kind: "delete" })}
            >
              <Icon name="trash" size={16} />
            </button>
          </div>
          <ShopifyBrands seller={s} onDone={load} />
          <dl className="details">
            <dt>Contact</dt>
            <dd>
              {[s.contactName, s.email, s.phone].filter(Boolean).join(" · ") ||
                "—"}
            </dd>
            <dt>GSTIN / PAN</dt>
            <dd>{[s.gstin, s.pan].filter(Boolean).join(" · ") || "—"}</dd>
            <dt>Pickup</dt>
            <dd>
              {s.pickup?.address
                ? `${[s.pickup.name, s.pickup.address, s.pickup.city, stateName(s.pickup.state), s.pickup.pincode].filter(Boolean).join(", ")} · ${s.pickup.phone || s.phone}`
                : "—"}
              {s.pickupMissing?.length > 0 && (
                <div className="small" style={{ color: "var(--red)" }}>
                  Missing: {s.pickupMissing.join(", ")}
                </div>
              )}
            </dd>
          </dl>

          <h4 style={{ margin: "6px 0 0" }}>Seller logins</h4>
          <p className="small muted" style={{ margin: 0 }}>
            They see only their own orders, download labels once you've booked,
            update their stock on Shopify and see their purchase orders. They
            can't book couriers.
          </p>
          <table className="table">
            <tbody>
              {s.users.map((u) => (
                <tr key={u._id}>
                  <td>
                    {u.name}
                    <div className="small muted">{u.email}</div>
                  </td>
                  <td className="small muted">
                    {u.status === "invited"
                      ? "Hasn't set a password yet"
                      : u.lastLogin
                        ? `Last login ${date(u.lastLogin)}`
                        : "Never logged in"}
                  </td>
                  <td className="num">
                    <button
                      className="icon-btn"
                      title="Remove login"
                      onClick={() =>
                        setConfirm({ kind: "login", id: u._id, name: u.name })
                      }
                    >
                      <Icon name="trash" size={14} />
                    </button>
                  </td>
                </tr>
              ))}
              {!s.users.length && (
                <tr>
                  <td className="muted small">No logins yet.</td>
                </tr>
              )}
            </tbody>
          </table>
          <div>
            <button className="btn btn-sm" onClick={() => setAddLogin(true)}>
              <Icon name="plus" size={14} /> Add seller login
            </button>
          </div>

          <h4 style={{ margin: "6px 0 0" }}>Pickup with couriers</h4>
          <p className="small muted" style={{ margin: 0 }}>
            Delhivery and Shiprocket keep pickup locations: register the
            seller's address once (done automatically on the first booking).
            Blue Dart, DTDC and Shadowfax take it with each booking.
          </p>
          <table className="table">
            <tbody>
              {s.couriers.map((c) => (
                <tr key={c.account}>
                  <td>
                    {c.name}
                    <div className="small muted">{c.carrier}</div>
                  </td>
                  <td className="small">
                    {c.pickupLocation && (
                      <div>
                        Pickup name: <strong>{c.pickupLocation}</strong>
                      </div>
                    )}
                    {(c.originArea || c.customerCode) && (
                      <div>
                        {[
                          c.originArea && `Area ${c.originArea}`,
                          c.customerCode && `Customer ${c.customerCode}`,
                          c.vendorCode && `Vendor ${c.vendorCode}`,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </div>
                    )}
                    <div className="muted">
                      {COURIER_STATUS[c.status] ||
                        (c.needsRegister
                          ? "Not registered yet"
                          : "Sent with each booking")}
                    </div>
                    {c.error && (
                      <div style={{ color: "var(--red)" }}>{c.error}</div>
                    )}
                  </td>
                  <td className="num" style={{ whiteSpace: "nowrap" }}>
                    {c.needsRegister && (
                      <button
                        className="btn btn-sm"
                        disabled={
                          busyAcc === c.account || s.pickupMissing?.length > 0
                        }
                        onClick={() => register(c.account)}
                      >
                        {busyAcc === c.account
                          ? "Registering…"
                          : c.pickupLocation
                            ? "Register again"
                            : "Register pickup"}
                      </button>
                    )}{" "}
                    <button className="btn btn-sm" onClick={() => setCodes(c)}>
                      Codes
                    </button>
                  </td>
                </tr>
              ))}
              {!s.couriers.length && (
                <tr>
                  <td className="muted small">No couriers set up.</td>
                </tr>
              )}
            </tbody>
          </table>

          <h4 style={{ margin: "6px 0 0" }}>Purchase orders</h4>
          {!s.purchaseOrders.length ? (
            <p className="muted small" style={{ margin: 0 }}>
              None yet. They're made on the 8th for the previous month's
              delivered orders.
            </p>
          ) : (
            <table className="table">
              <tbody>
                {s.purchaseOrders.map((p) => (
                  <tr key={p._id}>
                    <td>
                      <Link to={`/purchase-orders/${p._id}`} onClick={onClose}>
                        {p.number}
                      </Link>
                      <div className="small muted">{p.reference}</div>
                    </td>
                    <td>{date(p.date)}</td>
                    <td className="small">
                      {p.status === "billed"
                        ? `Billed ${p.billNumber}`
                        : p.status}
                    </td>
                    <td className="num">{money(p.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <h4 style={{ margin: "6px 0 0" }}>Deductions</h4>
          {!s.penalties.length ? (
            <p className="muted small" style={{ margin: 0 }}>
              None.
            </p>
          ) : (
            <table className="table">
              <tbody>
                {s.penalties.map((p) => (
                  <tr key={p._id}>
                    <td>{date(p.date)}</td>
                    <td>
                      {p.reason}
                      {p.orderName && (
                        <span className="muted small"> · {p.orderName}</span>
                      )}
                    </td>
                    <td className="small">
                      {p.purchaseOrderNumber
                        ? `Deducted on ${p.purchaseOrderNumber}`
                        : "Pending"}
                    </td>
                    <td className="num">{money(p.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
      {addLogin && (
        <AddLogin
          seller={s}
          onClose={() => setAddLogin(false)}
          onDone={(r) => {
            setAddLogin(false);
            changed();
            if (r.link) setInvite(r);
            else toast("Added: they already have an OrdexaGo login");
          }}
        />
      )}
      {invite && (
        <Modal
          open
          title="Seller login link"
          onClose={() => setInvite(null)}
          footer={
            <button className="btn btn-primary" onClick={() => setInvite(null)}>
              Done
            </button>
          }
        >
          <p style={{ marginTop: 0 }}>
            {invite.emailed
              ? "We emailed them a link to set their password. You can also share it:"
              : "The email couldn't be sent. Share this link with them (WhatsApp / email) to set their password:"}
          </p>
          <div style={{ display: "flex", gap: 6 }}>
            <input
              readOnly
              value={invite.link}
              onFocus={(e) => e.target.select()}
            />
            <button
              className="btn"
              onClick={() =>
                navigator.clipboard
                  ?.writeText(invite.link)
                  .then(() => toast("Link copied"))
              }
            >
              Copy
            </button>
          </div>
        </Modal>
      )}
      {pending && s && (
        <PendingOrders
          seller={s}
          onClose={() => setPending(false)}
          onChanged={onChanged}
        />
      )}
      {codes && (
        <CourierCodes
          seller={s}
          row={codes}
          onClose={() => setCodes(null)}
          onSaved={() => {
            setCodes(null);
            load();
          }}
        />
      )}
      <Confirm
        open={confirm?.kind === "login"}
        title={`Remove ${confirm?.name}'s login?`}
        text="They won't be able to log in to this seller dashboard any more."
        confirmLabel="Remove"
        onConfirm={() => removeLogin(confirm.id)}
        onCancel={() => setConfirm(null)}
      />
      <Confirm
        open={confirm?.kind === "delete"}
        title={`Delete ${s?.name}?`}
        text="Their orders become your own products again. Not possible once they have purchase orders — mark them inactive instead."
        onConfirm={remove}
        onCancel={() => setConfirm(null)}
      />
    </Modal>
  );
}

// What goes on this seller's next purchase order, and orders excluded for good (paid outside OrdexaGo).
// The orders (and deductions) that would go on one seller's purchase order, with a way to leave one out.
function PoOrders({ r, onExcluded }) {
  const [busy, setBusy] = useState(null);
  const exclude = async (o) => {
    const reason = window.prompt(
      `Leave ${o.name} off ${r.seller}'s purchase orders for good? Reason (e.g. paid in the old software):`,
      "",
    );
    if (reason === null) return;
    setBusy(o.id);
    try {
      await api.post(`/sellers/${r.sellerId}/exclude`, { ids: [o.id], reason });
      toast(`${o.name} excluded`);
      onExcluded();
    } catch (e) {
      toast(errMsg(e), "error");
    }
    setBusy(null);
  };
  return (
    <>
      <div className="small muted" style={{ marginBottom: 6 }}>
        {r.orderList.length} order{r.orderList.length === 1 ? "" : "s"} at the
        product's cost price in Shopify, or {r.rate}% of the sale price where it
        has none (incl. GST, before discounts)
        {r.waiting
          ? ` · ${r.waiting} more delivered less than 7 days ago wait for the next PO`
          : ""}
      </div>
      <table className="table" style={{ margin: 0 }}>
        <thead>
          <tr>
            <th>Order</th>
            <th>Delivered</th>
            <th>Items</th>
            <th className="num">Sale value</th>
            <th className="num">Purchase value</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {r.orderList.map((o) => (
            <tr key={o.id}>
              <td>
                <Link
                  to={`/shopify-orders?tab=all&q=${encodeURIComponent(o.name)}`}
                >
                  {o.name}
                </Link>
              </td>
              <td className="small">
                {o.deliveredAt ? date(o.deliveredAt) : ""}
              </td>
              <td className="small">
                {o.items.map((it, k) => (
                  <div key={k}>
                    {it.quantity} × {it.title}
                    {it.sku ? <span className="muted"> · {it.sku}</span> : ""}
                    {it.basis ? (
                      <span className="muted"> · {it.basis}</span>
                    ) : (
                      ""
                    )}
                  </div>
                ))}
              </td>
              <td className="num">{money(o.sale)}</td>
              <td className="num">{money(o.amount)}</td>
              <td className="num">
                <button
                  className="btn btn-sm btn-ghost"
                  disabled={busy === o.id}
                  onClick={() => exclude(o)}
                  title="Never put this order on a purchase order (e.g. already paid)"
                >
                  Exclude
                </button>
              </td>
            </tr>
          ))}
          {r.deductionList?.map((p) => (
            <tr key={p.id}>
              <td colSpan={4} className="small">
                Deduction{p.order ? ` (${p.order})` : ""}
                {p.reason ? ` — ${p.reason}` : ""}
              </td>
              <td className="num">− {money(p.amount)}</td>
              <td />
            </tr>
          ))}
          <tr className="row-total">
            <td colSpan={4}>PO total</td>
            <td className="num">{money(r.total)}</td>
            <td />
          </tr>
        </tbody>
      </table>
    </>
  );
}

function PendingOrders({ seller, onClose, onChanged }) {
  const [month, setMonth] = useState(prevMonth());
  const [data, setData] = useState(null);
  const [sel, setSel] = useState(new Set());
  const [names, setNames] = useState("");
  const [reason, setReason] = useState("Paid in the old software");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const load = () =>
    api
      .get(`/sellers/${seller._id}/pending`, { params: { month } })
      .then((r) => {
        setData(r.data);
        setSel(new Set());
      })
      .catch((e) => toast(errMsg(e), "error"));
  useEffect(() => {
    load();
  }, [month]);
  const exclude = async (body) => {
    setBusy(true);
    try {
      const { data: r } = await api.post(`/sellers/${seller._id}/exclude`, {
        ...body,
        reason,
      });
      setResult(r);
      if (r.excluded.length)
        toast(
          `${r.excluded.length} order${r.excluded.length > 1 ? "s" : ""} excluded`,
        );
      setNames("");
      load();
      onChanged();
    } catch (e) {
      toast(errMsg(e), "error");
    }
    setBusy(false);
  };
  const undo = async (o) => {
    try {
      await api.delete(`/sellers/${seller._id}/exclude/${o._id}`);
      toast(`${o.name} can go on a purchase order again`);
      load();
      onChanged();
    } catch (e) {
      toast(errMsg(e), "error");
    }
  };
  const rows = data?.rows || [];
  const total = rows.reduce((t, r) => t + r.amount, 0);
  const allOn = rows.length > 0 && rows.every((r) => sel.has(r._id));
  return (
    <Modal
      open
      wide
      title={`${seller.name}: next purchase order`}
      onClose={onClose}
    >
      {!data ? (
        <Spinner />
      ) : (
        <div className="form-grid">
          <div
            style={{
              display: "flex",
              gap: 8,
              alignItems: "flex-end",
              flexWrap: "wrap",
            }}
          >
            <Field label="Delivered up to the end of">
              <input
                type="month"
                value={month}
                onChange={(e) => setMonth(e.target.value)}
              />
            </Field>
            <p
              className="small muted"
              style={{ margin: 0, flex: 1, minWidth: 240 }}
            >
              Delivered {data.poFrom ? `from ${date(data.poFrom)} ` : ""}to the
              end of {data.label}, not returned, not on a PO yet. "Waiting" ones
              aren't 7 days past delivery yet. Exclude orders already paid
              outside OrdexaGo — they never go on a purchase order.
            </p>
          </div>
          {!rows.length ? (
            <Empty title="Nothing due" />
          ) : (
            <div
              style={{
                maxHeight: 340,
                overflow: "auto",
                border: "1px solid var(--line)",
                borderRadius: 8,
              }}
            >
              <table className="table">
                <thead>
                  <tr>
                    <th style={{ width: 32 }}>
                      <input
                        type="checkbox"
                        checked={allOn}
                        onChange={() =>
                          setSel(
                            allOn ? new Set() : new Set(rows.map((r) => r._id)),
                          )
                        }
                        aria-label="Select all"
                      />
                    </th>
                    <th>Order</th>
                    <th>Delivered</th>
                    <th>Items</th>
                    <th className="num">Sale value</th>
                    <th className="num">PO amount</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r._id}>
                      <td>
                        <input
                          type="checkbox"
                          checked={sel.has(r._id)}
                          onChange={() => {
                            const n = new Set(sel);
                            n.has(r._id) ? n.delete(r._id) : n.add(r._id);
                            setSel(n);
                          }}
                        />
                      </td>
                      <td className="strong">{r.name}</td>
                      <td>
                        {date(r.deliveredAt)}
                        {!r.ready && (
                          <div className="small muted">Waiting (7 days)</div>
                        )}
                      </td>
                      <td className="small">{r.items.join(", ")}</td>
                      <td className="num">{money(r.value)}</td>
                      <td className="num">{money(r.amount)}</td>
                    </tr>
                  ))}
                  <tr className="row-total">
                    <td colSpan={5}>
                      {rows.length} orders
                      {sel.size ? ` · ${sel.size} selected` : ""}
                    </td>
                    <td className="num">{money(total)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
          <div className="card" style={{ padding: 12 }}>
            <div className="row-2">
              <Field label="Reason">
                <input
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
              </Field>
              <Field
                label="Or paste order numbers"
                hint="From the old software, separated by spaces, commas or new lines"
              >
                <textarea
                  rows={2}
                  value={names}
                  onChange={(e) => setNames(e.target.value)}
                  placeholder="#199536 #199540 …"
                />
              </Field>
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button
                className="btn btn-primary"
                disabled={busy || !sel.size}
                onClick={() => exclude({ ids: [...sel] })}
              >
                Exclude {sel.size || ""} selected
              </button>
              <button
                className="btn"
                disabled={busy || !names.trim()}
                onClick={() => exclude({ names })}
              >
                Exclude pasted orders
              </button>
            </div>
            {result && (
              <div className="small" style={{ marginTop: 8 }}>
                {result.excluded.length > 0 && (
                  <div>Excluded: {result.excluded.join(", ")}</div>
                )}
                {result.alreadyExcluded.length > 0 && (
                  <div className="muted">
                    Already excluded: {result.alreadyExcluded.join(", ")}
                  </div>
                )}
                {result.alreadyOnPo.length > 0 && (
                  <div style={{ color: "var(--red)" }}>
                    Already on a PO: {result.alreadyOnPo.join(", ")}
                  </div>
                )}
                {result.notThisSeller.length > 0 && (
                  <div style={{ color: "var(--red)" }}>
                    No {seller.name} products: {result.notThisSeller.join(", ")}
                  </div>
                )}
                {result.notFound.length > 0 && (
                  <div style={{ color: "var(--red)" }}>
                    Not found: {result.notFound.join(", ")}
                  </div>
                )}
              </div>
            )}
          </div>
          <h4 style={{ margin: "6px 0 0" }}>
            Excluded orders ({data.excluded.length})
          </h4>
          {!data.excluded.length ? (
            <p className="small muted" style={{ margin: 0 }}>
              None.
            </p>
          ) : (
            <div style={{ maxHeight: 220, overflow: "auto" }}>
              <table className="table">
                <tbody>
                  {data.excluded.map((o) => (
                    <tr key={o._id}>
                      <td className="strong">{o.name}</td>
                      <td className="small">
                        {o.deliveredAt
                          ? `Delivered ${date(o.deliveredAt)}`
                          : ""}
                      </td>
                      <td className="small muted">
                        {o.reason} · {date(o.at)}
                      </td>
                      <td className="num">
                        <button className="btn btn-sm" onClick={() => undo(o)}>
                          Undo
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

function AddLogin({ seller, onClose, onDone }) {
  const [f, setF] = useState({
    name: seller.contactName || "",
    email: seller.email || "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const save = async () => {
    setBusy(true);
    setError("");
    try {
      const { data } = await api.post(`/sellers/${seller._id}/users`, f);
      onDone(data);
    } catch (e) {
      setError(errMsg(e));
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      title={`Login for ${seller.name}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            disabled={busy || !f.name.trim() || !f.email.trim()}
            onClick={save}
          >
            {busy ? "Adding…" : "Add & send link"}
          </button>
        </>
      }
    >
      <div className="form-grid">
        <Field label="Name" required>
          <input
            autoFocus
            value={f.name}
            onChange={(e) => setF({ ...f, name: e.target.value })}
          />
        </Field>
        <Field
          label="Email"
          required
          hint="Their login. Must not already be one of your staff logins."
        >
          <input
            type="email"
            value={f.email}
            onChange={(e) => setF({ ...f, email: e.target.value })}
          />
        </Field>
        {error && <div className="alert alert-error">{error}</div>}
      </div>
    </Modal>
  );
}

function CourierCodes({ seller, row, onClose, onSaved }) {
  const [f, setF] = useState({
    pickupLocation: row.pickupLocation || "",
    originArea: row.originArea || "",
    customerCode: row.customerCode || "",
    vendorCode: row.vendorCode || "",
  });
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await api.put(`/sellers/${seller._id}/couriers/${row.account}`, f);
      toast("Saved");
      onSaved();
    } catch (e) {
      toast(errMsg(e), "error");
      setBusy(false);
    }
  };
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  return (
    <Modal
      open
      title={`${row.name}: ${seller.name}'s pickup`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={busy} onClick={save}>
            Save
          </button>
        </>
      }
    >
      <div className="form-grid">
        {["shiprocket", "delhivery"].includes(row.carrier) && (
          <Field
            label={
              row.carrier === "delhivery"
                ? "Warehouse (pickup location) name"
                : "Pickup location nickname"
            }
            hint="If it's already set up in the courier's panel, type its exact name here instead of registering"
          >
            <input value={f.pickupLocation} onChange={set("pickupLocation")} />
          </Field>
        )}
        {row.carrier === "bluedart" && (
          <>
            <p className="small muted" style={{ margin: 0 }}>
              Only if Blue Dart gave this seller's location its own codes; blank
              uses the account's.
            </p>
            <div className="row-3">
              <Field label="Area code">
                <input
                  value={f.originArea}
                  maxLength={10}
                  onChange={set("originArea")}
                />
              </Field>
              <Field label="Customer code">
                <input value={f.customerCode} onChange={set("customerCode")} />
              </Field>
              <Field label="Vendor code">
                <input value={f.vendorCode} onChange={set("vendorCode")} />
              </Field>
            </div>
          </>
        )}
        {!["shiprocket", "delhivery", "bluedart"].includes(row.carrier) && (
          <p className="small muted">
            Nothing to set: the seller's address goes with each booking.
          </p>
        )}
      </div>
    </Modal>
  );
}

/* ======================= Penalties ======================= */
function Penalties({ sellers, onChanged }) {
  const [list, setList] = useState(null);
  const [seller, setSeller] = useState("");
  const [state, setState] = useState("");
  const [add, setAdd] = useState(false);
  const [del, setDel] = useState(null);
  const load = () =>
    api
      .get("/sellers/penalties/list", {
        params: { seller: seller || undefined, state: state || undefined },
      })
      .then((r) => setList(r.data))
      .catch((e) => toast(errMsg(e), "error"));
  useEffect(() => {
    load();
  }, [seller, state]);
  const remove = async () => {
    try {
      await api.delete(`/sellers/penalties/${del._id}`);
      toast("Deduction removed");
      load();
      onChanged();
    } catch (e) {
      toast(errMsg(e), "error");
    }
    setDel(null);
  };
  return (
    <>
      <div
        style={{
          display: "flex",
          gap: 8,
          alignItems: "center",
          flexWrap: "wrap",
          marginBottom: 12,
        }}
      >
        <select
          value={seller}
          onChange={(e) => setSeller(e.target.value)}
          style={{ width: "auto" }}
        >
          <option value="">All sellers</option>
          {sellers.map((s) => (
            <option key={s._id} value={s._id}>
              {s.name}
            </option>
          ))}
        </select>
        <select
          value={state}
          onChange={(e) => setState(e.target.value)}
          style={{ width: "auto" }}
        >
          <option value="">Pending and deducted</option>
          <option value="pending">Pending</option>
          <option value="applied">Deducted</option>
        </select>
        <div style={{ flex: 1 }} />
        <button
          className="btn btn-primary"
          disabled={!sellers.length}
          onClick={() => setAdd(true)}
        >
          <Icon name="plus" size={16} /> Add deduction
        </button>
      </div>
      <p className="small muted" style={{ marginTop: 0 }}>
        A pending deduction is taken off the seller's next monthly purchase
        order, so their invoice already comes net of it. It has no ledger of its
        own: on the bill it simply lowers the purchase.
      </p>
      {!list ? (
        <Spinner />
      ) : !list.length ? (
        <Empty title="No deductions" />
      ) : (
        <div className="card" style={{ padding: 0, overflowX: "auto" }}>
          <table className="table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Seller</th>
                <th>Reason</th>
                <th>Order</th>
                <th>Status</th>
                <th className="num">Amount</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.map((p) => (
                <tr key={p._id}>
                  <td>{date(p.date)}</td>
                  <td>{p.seller?.name}</td>
                  <td>{p.reason}</td>
                  <td>{p.orderName || "—"}</td>
                  <td className="small">
                    {p.purchaseOrderNumber
                      ? `Deducted on ${p.purchaseOrderNumber}`
                      : "Pending"}
                  </td>
                  <td className="num">{money(p.amount)}</td>
                  <td className="num">
                    {!p.purchaseOrder && (
                      <button
                        className="icon-btn"
                        title="Remove"
                        onClick={() => setDel(p)}
                      >
                        <Icon name="trash" size={14} />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {add && (
        <AddPenalty
          sellers={sellers}
          initial={seller}
          onClose={() => setAdd(false)}
          onSaved={() => {
            setAdd(false);
            load();
            onChanged();
          }}
        />
      )}
      <Confirm
        open={!!del}
        title="Remove this deduction?"
        text={del ? `${del.reason} — ${money(del.amount)}` : ""}
        confirmLabel="Remove"
        onConfirm={remove}
        onCancel={() => setDel(null)}
      />
    </>
  );
}

function AddPenalty({ sellers, initial, onClose, onSaved }) {
  const [f, setF] = useState({
    seller: initial || sellers[0]?._id || "",
    date: isoDate(new Date()),
    amount: "",
    reason: "",
    orderName: "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const save = async () => {
    setBusy(true);
    setError("");
    try {
      await api.post("/sellers/penalties", { ...f, amount: Number(f.amount) });
      toast("Deduction added");
      onSaved();
    } catch (e) {
      setError(errMsg(e));
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      title="Add deduction"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            disabled={
              busy ||
              !f.seller ||
              !(Number(f.amount) > 0) ||
              f.reason.trim().length < 2
            }
            onClick={save}
          >
            {busy ? "Saving…" : "Save"}
          </button>
        </>
      }
    >
      <div className="form-grid">
        <Field label="Seller" required>
          <select value={f.seller} onChange={set("seller")}>
            {sellers.map((s) => (
              <option key={s._id} value={s._id}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>
        <div className="row-2">
          <Field label="Date" required>
            <input type="date" value={f.date} onChange={set("date")} />
          </Field>
          <Field label="Amount (₹)" required>
            <input
              type="number"
              min="0"
              step="0.01"
              value={f.amount}
              onChange={set("amount")}
            />
          </Field>
        </div>
        <Field label="Reason" required>
          <input
            value={f.reason}
            onChange={set("reason")}
            placeholder="e.g. Late dispatch, wrong product sent, damaged packing"
          />
        </Field>
        <Field label="Order # (optional)">
          <input
            value={f.orderName}
            onChange={set("orderName")}
            placeholder="#1234"
          />
        </Field>
        {error && <div className="alert alert-error">{error}</div>}
      </div>
    </Modal>
  );
}

/* ======================= Monthly purchase orders ======================= */
function MonthlyPos({ sellers }) {
  const [month, setMonth] = useState(prevMonth());
  const [seller, setSeller] = useState("");
  const [preview, setPreview] = useState(null);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [openRow, setOpenRow] = useState(null);
  const look = async () => {
    setBusy(true);
    setResult(null);
    try {
      const { data } = await api.get("/sellers/purchase-orders/preview", {
        params: { month },
      });
      setPreview(data);
    } catch (e) {
      toast(errMsg(e), "error");
    }
    setBusy(false);
  };
  useEffect(() => {
    if (sellers.length) look();
  }, [month]);
  const run = async () => {
    setConfirm(false);
    setBusy(true);
    try {
      const { data } = await api.post("/sellers/purchase-orders/run", {
        month,
        seller,
      });
      setResult(data);
      const made = data.results.filter((r) => r.purchaseOrder).length;
      toast(
        made
          ? `${made} purchase order${made > 1 ? "s" : ""} created`
          : "Nothing new to put on a purchase order",
      );
      look();
    } catch (e) {
      toast(errMsg(e), "error");
    }
    setBusy(false);
  };
  const rows = useMemo(
    () =>
      (preview?.results || []).filter(
        (r) => !seller || String(r.sellerId) === seller,
      ),
    [preview, seller],
  );
  const sum = rows.reduce((t, r) => t + (r.total || 0), 0);
  return (
    <>
      <div className="card" style={{ padding: 14, marginBottom: 12 }}>
        <p className="small" style={{ margin: "0 0 10px" }}>
          On the <strong>8th of every month</strong> OrdexaGo creates a purchase
          order for each seller, for their orders{" "}
          <strong>
            delivered by the end of the previous month, at least 7 days ago,
            with no return or RTO since
          </strong>
          , not on an earlier PO:{" "}
          {`seller's rate × sale price incl. GST, before discounts`}, minus
          pending deductions. By the 8th, even an order delivered on the 31st
          has had its 7 days. It's raised in the company that invoiced the
          orders. You can also run it here.
        </p>
        <div
          style={{
            display: "flex",
            gap: 8,
            alignItems: "flex-end",
            flexWrap: "wrap",
          }}
        >
          <Field label="Delivered up to the end of">
            <input
              type="month"
              value={month}
              onChange={(e) => setMonth(e.target.value)}
            />
          </Field>
          <Field label="Seller">
            <select value={seller} onChange={(e) => setSeller(e.target.value)}>
              <option value="">All sellers</option>
              {sellers.map((s) => (
                <option key={s._id} value={s._id}>
                  {s.name}
                </option>
              ))}
            </select>
          </Field>
          <button className="btn" disabled={busy} onClick={look}>
            Refresh
          </button>
          <button
            className="btn btn-primary"
            disabled={busy || !rows.some((r) => r.total > 0)}
            onClick={() => setConfirm(true)}
          >
            Create purchase orders now
          </button>
        </div>
      </div>
      {busy && !preview ? (
        <Spinner />
      ) : preview ? (
        <>
          <h4 style={{ margin: "4px 0 8px" }}>
            Ready to go on a purchase order (delivered by the end of{" "}
            {preview.label}, 7+ days ago)
          </h4>
          {!rows.length ? (
            <Empty title="Nothing pending" />
          ) : (
            <div className="card" style={{ padding: 0, overflowX: "auto" }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Seller</th>
                    <th>Company</th>
                    <th className="num">Orders</th>
                    <th className="num">Waiting 7 days</th>
                    <th className="num">Purchase value</th>
                    <th className="num">Deductions</th>
                    <th className="num">PO total</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <Fragment key={i}>
                      <tr
                        style={
                          r.orderList?.length
                            ? { cursor: "pointer" }
                            : undefined
                        }
                        onClick={
                          r.orderList?.length
                            ? () => setOpenRow(openRow === i ? null : i)
                            : undefined
                        }
                        title={
                          r.orderList?.length
                            ? "Click to see the orders on this PO"
                            : ""
                        }
                      >
                        <td>
                          {r.orderList?.length > 0 && (
                            <span
                              style={{ display: "inline-block", width: 14 }}
                            >
                              {openRow === i ? "▾" : "▸"}
                            </span>
                          )}
                          {r.seller}
                        </td>
                        <td
                          colSpan={r.skipped || r.error ? 6 : 1}
                          className={
                            r.skipped ? "muted small" : r.error ? "small" : ""
                          }
                          style={r.error ? { color: "var(--red)" } : undefined}
                        >
                          {r.skipped || r.error || r.company}
                        </td>
                        {!r.skipped && !r.error && (
                          <>
                            <td className="num">{r.orders}</td>
                            <td className="num muted">{r.waiting || "—"}</td>
                            <td className="num">{money(r.amount)}</td>
                            <td className="num">
                              {r.penalties ? `− ${money(r.penalties)}` : "—"}
                            </td>
                            <td className="num strong">{money(r.total)}</td>
                          </>
                        )}
                      </tr>
                      {openRow === i && r.orderList && (
                        <tr>
                          <td
                            colSpan={7}
                            style={{
                              background: "var(--bg)",
                              padding: "8px 12px 12px 26px",
                            }}
                          >
                            <PoOrders r={r} onExcluded={look} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                  <tr className="row-total">
                    <td colSpan={6}>Total</td>
                    <td className="num">{money(sum)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </>
      ) : null}
      {result && result.results.some((r) => r.purchaseOrder) && (
        <>
          <h4 style={{ margin: "16px 0 8px" }}>Created</h4>
          <div className="card" style={{ padding: 0 }}>
            <table className="table">
              <tbody>
                {result.results
                  .filter((r) => r.purchaseOrder)
                  .map((r) => (
                    <tr key={r.purchaseOrderId}>
                      <td>{r.seller}</td>
                      <td>{r.company}</td>
                      <td>
                        <Link to={`/purchase-orders/${r.purchaseOrderId}`}>
                          {r.purchaseOrder}
                        </Link>
                      </td>
                      <td className="num">{money(r.total)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      <Confirm
        open={confirm}
        title={`Create purchase orders for ${preview?.label}?`}
        text="One per seller and company, issued to the seller. Orders on them won't be put on a PO again."
        confirmLabel="Create"
        danger={false}
        onConfirm={run}
        onCancel={() => setConfirm(false)}
      />
    </>
  );
}

/* ======================= Brand pages on Shopify ======================= */
function ShopifyBrands({ seller, onDone }) {
  const [busy, setBusy] = useState(false);
  const sb = seller.shopifyBrands || {};
  const rows = (seller.brands || []).map((b) => ({
    brand: b,
    ...(sb[b] || {}),
  }));
  const allGood = rows.length && rows.every((r) => r.id && r.published);
  const run = async () => {
    setBusy(true);
    try {
      const { data } = await api.post(`/sellers/${seller._id}/shopify-brands`);
      const bad = Object.values(data).filter((x) => x.error);
      toast(
        bad.length ? bad[0].error : "Brand pages are on Shopify",
        bad.length ? "error" : undefined,
      );
      onDone();
    } catch (e) {
      toast(errMsg(e), "error");
    }
    setBusy(false);
  };
  return (
    <div
      className="small"
      style={{
        display: "flex",
        gap: 8,
        flexWrap: "wrap",
        alignItems: "center",
      }}
    >
      <span className="muted">Brand on Shopify:</span>
      {rows.map((r) => (
        <span
          key={r.brand}
          className={`pill ${r.id ? (r.published ? "pill-green" : "pill-amber") : r.error ? "pill-red" : ""}`}
          title={
            r.error ||
            r.note ||
            (r.handle ? `/collections/${r.handle}` : "Not created yet")
          }
        >
          {r.brand}:{" "}
          {r.id
            ? r.published
              ? "brand page live"
              : "created, not on the website"
            : r.error
              ? "not created"
              : "not created yet"}
        </span>
      ))}
      {!allGood && (
        <button className="btn btn-sm" disabled={busy} onClick={run}>
          {busy ? "Creating…" : "Create on Shopify"}
        </button>
      )}
      {rows.find((r) => r.error) && (
        <span className="text-amber">{rows.find((r) => r.error).error}</span>
      )}
    </div>
  );
}

/* ======================= Website registrations ======================= */
function Registrations({ sellers, reload }) {
  const [show, setShow] = useState("pending");
  const [approve, setApprove] = useState(null);
  const [reject, setReject] = useState(null);
  const rows = sellers
    .filter((s) => s.status === show)
    .sort(
      (a, b) =>
        new Date(b.application?.appliedAt || b.createdAt) -
        new Date(a.application?.appliedAt || a.createdAt),
    );
  return (
    <>
      <div
        style={{
          display: "flex",
          gap: 8,
          alignItems: "center",
          flexWrap: "wrap",
          marginBottom: 12,
        }}
      >
        <div className="seg" role="group">
          {[
            ["pending", "Waiting for approval"],
            ["rejected", "Rejected"],
          ].map(([k, l]) => (
            <button
              key={k}
              type="button"
              className={show === k ? "on" : ""}
              onClick={() => setShow(k)}
            >
              {l} ({sellers.filter((s) => s.status === k).length})
            </button>
          ))}
        </div>
        <span className="small muted">
          Sellers register on woodentwist.com/pages/sell-online. Approve to make
          them a seller (with their brand on Shopify and a dashboard login), or
          reject.
        </span>
      </div>
      {!rows.length ? (
        <Empty
          title={
            show === "pending"
              ? "No registrations waiting"
              : "No rejected registrations"
          }
          text="New registrations from the website appear here, and you get an email for each."
        />
      ) : (
        <div className="card" style={{ padding: 0, overflowX: "auto" }}>
          <table className="table">
            <thead>
              <tr>
                <th>Applied</th>
                <th>Brand / business</th>
                <th>Contact</th>
                <th>Pickup</th>
                <th>Products</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => {
                const a = s.application || {};
                return (
                  <tr key={s._id}>
                    <td className="small">
                      {date(a.appliedAt || s.createdAt)}
                    </td>
                    <td>
                      <div className="strong">{a.brand || "—"}</div>
                      <div className="small muted">{s.name}</div>
                      {[
                        s.gstin && `GSTIN ${s.gstin}`,
                        s.pan && `PAN ${s.pan}`,
                      ].filter(Boolean).length > 0 && (
                        <div className="small muted">
                          {[
                            s.gstin && `GSTIN ${s.gstin}`,
                            s.pan && `PAN ${s.pan}`,
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </div>
                      )}
                    </td>
                    <td className="small">
                      {s.contactName}
                      <div className="muted">
                        {[s.phone, s.email].filter(Boolean).join(" · ")}
                      </div>
                    </td>
                    <td className="small">
                      {[
                        s.pickup?.address,
                        s.pickup?.city,
                        stateName(s.pickup?.state),
                        s.pickup?.pincode,
                      ]
                        .filter(Boolean)
                        .join(", ")}
                    </td>
                    <td className="small">
                      {[
                        a.categories,
                        a.productCount && `${a.productCount} products`,
                      ]
                        .filter(Boolean)
                        .join(" · ") || "—"}
                      {a.website && (
                        <div>
                          <a
                            href={
                              /^https?:/i.test(a.website)
                                ? a.website
                                : `https://${a.website}`
                            }
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            {a.website}
                          </a>
                        </div>
                      )}
                      {a.message && (
                        <div
                          className="muted"
                          style={{ whiteSpace: "pre-wrap" }}
                        >
                          {a.message}
                        </div>
                      )}
                      {show === "rejected" && (
                        <div className="text-amber">
                          Rejected{" "}
                          {a.decidedByName ? `by ${a.decidedByName}` : ""}
                          {a.reason ? `: ${a.reason}` : ""}
                        </div>
                      )}
                    </td>
                    <td className="num" style={{ whiteSpace: "nowrap" }}>
                      {show === "pending" && (
                        <>
                          <button
                            className="btn btn-sm btn-primary"
                            onClick={() => setApprove(s)}
                          >
                            Approve
                          </button>{" "}
                          <button
                            className="btn btn-sm"
                            onClick={() => setReject(s)}
                          >
                            Reject
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {approve && (
        <ApproveSeller
          seller={approve}
          onClose={() => setApprove(null)}
          onDone={() => (setApprove(null), reload())}
        />
      )}
      {reject && (
        <RejectSeller
          seller={reject}
          onClose={() => setReject(null)}
          onDone={() => (setReject(null), reload())}
        />
      )}
    </>
  );
}

function ApproveSeller({ seller, onClose, onDone }) {
  const [f, setF] = useState({
    name: seller.name,
    brands: seller.application?.brand || "",
    rate: "",
    createLogin: !!seller.email,
  });
  const [busy, setBusy] = useState(false);
  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const { data } = await api.post(`/sellers/${seller._id}/approve`, {
        name: f.name,
        brands: f.brands
          .split(",")
          .map((b) => b.trim())
          .filter(Boolean),
        rate: Number(f.rate),
        createLogin: f.createLogin,
      });
      const bad = Object.values(data.shopifyBrands || {}).find((x) => x.error);
      toast(
        [
          `${f.name} approved`,
          bad
            ? `brand not created on Shopify: ${bad.error}`
            : "brand page created on Shopify",
          data.login?.emailed
            ? `login emailed to ${seller.email}`
            : data.login?.error
              ? `login not created: ${data.login.error}`
              : data.login?.link
                ? "login link ready in the seller's page"
                : "",
        ]
          .filter(Boolean)
          .join(" · "),
        bad || data.login?.error ? "error" : undefined,
      );
      onDone();
    } catch (err) {
      toast(errMsg(err), "error");
    }
    setBusy(false);
  };
  return (
    <Modal
      open
      title={`Approve ${seller.application?.brand || seller.name}`}
      onClose={onClose}
    >
      <form className="form-grid" onSubmit={save}>
        <Field label="Seller name" required>
          <input
            value={f.name}
            onChange={(e) => setF({ ...f, name: e.target.value })}
            required
          />
        </Field>
        <Field
          label="Brands (Shopify Vendor)"
          required
          hint="Comma-separated. Each brand gets its own collection page on Shopify, and their products use it as Vendor."
        >
          <input
            value={f.brands}
            onChange={(e) => setF({ ...f, brands: e.target.value })}
            required
          />
        </Field>
        <Field
          label="Purchase rate %"
          required
          hint="What we pay the seller, as % of the sale price, where a product has no agreed cost price"
        >
          <input
            type="number"
            min="0"
            max="100"
            step="0.01"
            value={f.rate}
            onChange={(e) => setF({ ...f, rate: e.target.value })}
            required
          />
        </Field>
        <label className="check">
          <input
            type="checkbox"
            checked={f.createLogin}
            disabled={!seller.email}
            onChange={(e) => setF({ ...f, createLogin: e.target.checked })}
          />{" "}
          Email a dashboard login to{" "}
          {seller.email || "the seller (no email given)"}
        </label>
        <div className="form-actions">
          <button className="btn btn-primary" disabled={busy}>
            {busy ? "Approving…" : "Approve seller"}
          </button>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </Modal>
  );
}

function RejectSeller({ seller, onClose, onDone }) {
  const [reason, setReason] = useState("");
  const [notify, setNotify] = useState(true);
  const [busy, setBusy] = useState(false);
  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.post(`/sellers/${seller._id}/reject`, { reason, notify });
      toast("Registration rejected");
      onDone();
    } catch (err) {
      toast(errMsg(err), "error");
    }
    setBusy(false);
  };
  return (
    <Modal
      open
      title={`Reject ${seller.application?.brand || seller.name}`}
      onClose={onClose}
    >
      <form className="form-grid" onSubmit={save}>
        <Field label="Reason" hint="Included in the email to the seller">
          <textarea
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={500}
          />
        </Field>
        <label className="check">
          <input
            type="checkbox"
            checked={notify}
            onChange={(e) => setNotify(e.target.checked)}
          />{" "}
          Email the seller{seller.email ? ` (${seller.email})` : ""}
        </label>
        <div className="form-actions">
          <button className="btn btn-danger" disabled={busy}>
            {busy ? "Rejecting…" : "Reject registration"}
          </button>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </Modal>
  );
}

/* ======================= Seller listings (review) ======================= */
const LISTING_STATUS = {
  queued: ["Queued", ""],
  creating: ["Creating on Shopify", "pill-blue"],
  draft: ["Draft — to review", "pill-amber"],
  failed: ["Failed", "pill-red"],
  approved: ["Approved · live", "pill-green"],
  rejected: ["Rejected", ""],
};

function Listings({ sellers, onCount }) {
  const [status, setStatus] = useState("review");
  const [seller, setSeller] = useState("");
  const [q, setQ] = useState("");
  const [data, setData] = useState(null);
  const [open, setOpen] = useState(null);
  const load = () =>
    api
      .get("/seller-listings", {
        params: { status, seller: seller || undefined, q: q || undefined },
      })
      .then((r) => {
        setData(r.data);
        onCount?.(r.data.counts.draft || 0);
      })
      .catch((e) => toast(errMsg(e), "error"));
  useEffect(() => {
    const t = setTimeout(load, q ? 300 : 0);
    return () => clearTimeout(t);
  }, [status, seller, q]);
  // Refresh while drafts are being created.
  useEffect(() => {
    if (!data?.rows.some((l) => ["queued", "creating"].includes(l.status)))
      return;
    const t = setTimeout(load, 5000);
    return () => clearTimeout(t);
  }, [data]);
  const c = data?.counts || {};
  const retryAll = async () => {
    try {
      const { data: r } = await api.post("/seller-listings/retry-failed");
      toast(`${r.queued} listing(s) queued again`);
      load();
    } catch (e) {
      toast(errMsg(e), "error");
    }
  };
  return (
    <>
      <div
        style={{
          display: "flex",
          gap: 8,
          alignItems: "center",
          flexWrap: "wrap",
          marginBottom: 12,
        }}
      >
        <div className="seg" role="group">
          {[
            ["review", "To review", c.review],
            ["failed", "Failed", c.failed],
            ["approved", "Approved", c.approved],
            ["rejected", "Rejected", c.rejected],
            ["all", "All", c.all],
          ].map(([k, l, n]) => (
            <button
              key={k}
              type="button"
              className={status === k ? "on" : ""}
              onClick={() => setStatus(k)}
            >
              {l} ({n || 0})
            </button>
          ))}
        </div>
        <select value={seller} onChange={(e) => setSeller(e.target.value)}>
          <option value="">All sellers</option>
          {sellers.map((s) => (
            <option key={s._id} value={s._id}>
              {s.name}
            </option>
          ))}
        </select>
        <SearchBox value={q} onChange={setQ} placeholder="Title, SKU, brand" />
        {status === "failed" && c.failed > 0 && (
          <button className="btn btn-sm" onClick={retryAll}>
            Retry all failed
          </button>
        )}
      </div>
      {!data ? (
        <Spinner />
      ) : !data.rows.length ? (
        <Empty
          title="No listings here"
          text="Sellers upload listing files from their dashboard (Listings tab). Each product becomes a draft on Shopify for you to check, price and approve."
        />
      ) : (
        <div className="card" style={{ padding: 0, overflowX: "auto" }}>
          <table className="table table-click">
            <thead>
              <tr>
                <th>Product</th>
                <th>Seller</th>
                <th>SKU</th>
                <th className="num">Seller price</th>
                <th className="num">Cost to us</th>
                <th>Status</th>
                <th>Uploaded</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((l) => {
                const [label, pill] = LISTING_STATUS[l.status] || [
                  l.status,
                  "",
                ];
                const v = l.variants || [];
                return (
                  <tr key={l._id} onClick={() => setOpen(l)}>
                    <td>
                      <div
                        style={{
                          display: "flex",
                          gap: 8,
                          alignItems: "center",
                        }}
                      >
                        {l.images?.[0]?.src && (
                          <img
                            src={l.images[0].src}
                            alt=""
                            style={{
                              width: 40,
                              height: 40,
                              objectFit: "cover",
                              borderRadius: 4,
                            }}
                            loading="lazy"
                          />
                        )}
                        <div>
                          <div className="strong">{l.title}</div>
                          <div className="small muted">
                            {l.productType} ·{" "}
                            {v.length > 1
                              ? `${v.length} variants`
                              : "1 variant"}{" "}
                            · {l.images?.length || 0} images
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="small">
                      {l.sellerName}
                      <div className="muted">{l.brand}</div>
                    </td>
                    <td className="small">
                      {v
                        .map((x) => x.sku)
                        .join(", ")
                        .slice(0, 60)}
                    </td>
                    <td className="num">
                      {v.length ? money(v[0].price) : "—"}
                    </td>
                    <td className="num">{v.length ? money(v[0].cost) : "—"}</td>
                    <td>
                      <span className={`pill ${pill}`}>{label}</span>
                      {l.status === "failed" && (
                        <div
                          className="small"
                          style={{ color: "var(--red)", maxWidth: 260 }}
                        >
                          {l.error}
                        </div>
                      )}
                    </td>
                    <td className="small">{date(l.createdAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {data.total > data.rows.length && (
            <p className="small muted" style={{ padding: 8 }}>
              Showing {data.rows.length} of {data.total} — narrow with the
              filters.
            </p>
          )}
        </div>
      )}
      {open && (
        <ListingReview
          listing={open}
          adminBase={data?.adminBase}
          onClose={() => setOpen(null)}
          onDone={() => (setOpen(null), load())}
        />
      )}
    </>
  );
}

function ListingReview({ listing: l, adminBase, onClose, onDone }) {
  const [prices, setPrices] = useState(() =>
    (l.variants || []).map((v) => ({
      sku: v.sku,
      price: v.finalPrice ?? v.price ?? "",
      compareAtPrice: v.finalCompareAt ?? v.compareAtPrice ?? "",
    })),
  );
  const [reason, setReason] = useState("");
  const [rejecting, setRejecting] = useState(false);
  const [deleteDraft, setDeleteDraft] = useState(true);
  const [busy, setBusy] = useState(false);
  const shopifyUrl =
    l.shopifyId && adminBase ? adminBase + l.shopifyId.split("/").pop() : "";
  const act = async (fn, ok) => {
    setBusy(true);
    try {
      const { data } = await fn();
      toast(
        ok + (data?.note ? ` — ${data.note}` : ""),
        data?.published === false ? "error" : undefined,
      );
      onDone();
    } catch (e) {
      toast(errMsg(e), "error");
    }
    setBusy(false);
  };
  const setP = (i, k) => (e) =>
    setPrices(
      prices.map((p, j) => (j === i ? { ...p, [k]: e.target.value } : p)),
    );
  const [label, pill] = LISTING_STATUS[l.status] || [l.status, ""];
  return (
    <Modal open wide title={l.title} onClose={onClose}>
      <div className="form-grid">
        <div
          style={{
            display: "flex",
            gap: 8,
            flexWrap: "wrap",
            alignItems: "center",
          }}
        >
          <span className={`pill ${pill}`}>{label}</span>
          <span className="small muted">
            {l.sellerName} · brand {l.brand} · {l.productType} · uploaded{" "}
            {date(l.createdAt)}
            {l.fileName ? ` from ${l.fileName}` : ""}
          </span>
          <div style={{ flex: 1 }} />
          {shopifyUrl && (
            <a
              className="btn btn-sm"
              href={shopifyUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              Open in Shopify
            </a>
          )}
        </div>
        {l.status === "failed" && (
          <div className="alert alert-warn small">{l.error}</div>
        )}
        {l.status === "rejected" && (
          <div className="alert alert-warn small">
            Rejected{l.reviewedByName ? ` by ${l.reviewedByName}` : ""}:{" "}
            {l.reason}
          </div>
        )}
        <div style={{ display: "flex", gap: 6, overflowX: "auto" }}>
          {(l.images || []).map((im, i) => (
            <a key={i} href={im.src} target="_blank" rel="noopener noreferrer">
              <img
                src={im.src}
                alt={im.alt}
                style={{
                  width: 96,
                  height: 96,
                  objectFit: "cover",
                  borderRadius: 6,
                  border: "1px solid var(--border)",
                }}
                loading="lazy"
              />
            </a>
          ))}
        </div>
        <div
          className="rte small"
          style={{
            maxHeight: 180,
            overflow: "auto",
            border: "1px solid var(--border)",
            borderRadius: 6,
            padding: 8,
          }}
          dangerouslySetInnerHTML={{ __html: l.descriptionHtml || "" }}
        />
        <div className="small muted">
          Tags: {(l.tags || []).join(", ") || "—"} · Packed box {l.size?.length}
          ×{l.size?.breadth}×{l.size?.height} cm
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>Variant</th>
              <th>SKU</th>
              <th className="num">Stock</th>
              <th className="num">Weight</th>
              <th>HSN · GST</th>
              <th className="num">Cost to us</th>
              <th className="num">Seller's price</th>
              <th className="num">Our selling price</th>
              <th className="num">MRP</th>
            </tr>
          </thead>
          <tbody>
            {(l.variants || []).map((v, i) => (
              <tr key={v.sku}>
                <td className="small">
                  {(v.options || []).join(" / ") || "—"}
                </td>
                <td className="small">{v.sku}</td>
                <td className="num">{v.qty}</td>
                <td className="num small">
                  {v.grams ? `${(v.grams / 1000).toFixed(2)} kg` : "—"}
                </td>
                <td className="small">
                  {v.hsn} · {v.gst}%
                </td>
                <td className="num">{money(v.cost)}</td>
                <td className="num">{money(v.price)}</td>
                <td className="num" style={{ width: 120 }}>
                  {l.status === "draft" ? (
                    <input
                      type="number"
                      min="0"
                      step="1"
                      value={prices[i]?.price}
                      onChange={setP(i, "price")}
                    />
                  ) : (
                    money(v.finalPrice ?? v.price)
                  )}
                </td>
                <td className="num" style={{ width: 110 }}>
                  {l.status === "draft" ? (
                    <input
                      type="number"
                      min="0"
                      step="1"
                      value={prices[i]?.compareAtPrice}
                      onChange={setP(i, "compareAtPrice")}
                    />
                  ) : v.finalCompareAt ? (
                    money(v.finalCompareAt)
                  ) : (
                    "—"
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {(l.variants || []).some(
          (v, i) => Number(prices[i]?.price) > 0 && v.cost > 0,
        ) &&
          l.status === "draft" && (
            <div className="small muted">
              Margin on cost:{" "}
              {(l.variants || [])
                .map(
                  (v, i) =>
                    `${v.sku} ${Math.round(((Number(prices[i]?.price) - v.cost) / Number(prices[i]?.price)) * 100)}%`,
                )
                .join(" · ")}
            </div>
          )}
        {rejecting ? (
          <div className="card">
            <Field
              label="Why is it rejected?"
              required
              hint="The seller sees this in their dashboard"
            >
              <textarea
                rows={3}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                maxLength={500}
              />
            </Field>
            {l.shopifyId && (
              <label className="check small">
                <input
                  type="checkbox"
                  checked={deleteDraft}
                  onChange={(e) => setDeleteDraft(e.target.checked)}
                />{" "}
                Delete the draft product from Shopify
              </label>
            )}
            <div className="form-actions">
              <button
                className="btn btn-danger"
                disabled={busy || reason.trim().length < 3}
                onClick={() =>
                  act(
                    () =>
                      api.post(`/seller-listings/${l._id}/reject`, {
                        reason,
                        deleteDraft,
                      }),
                    "Listing rejected",
                  )
                }
              >
                Reject listing
              </button>
              <button
                className="btn btn-ghost"
                onClick={() => setRejecting(false)}
              >
                Back
              </button>
            </div>
          </div>
        ) : (
          <div className="form-actions">
            {l.status === "draft" && (
              <button
                className="btn btn-primary"
                disabled={busy}
                onClick={() =>
                  act(
                    () =>
                      api.post(`/seller-listings/${l._id}/approve`, {
                        prices: prices.map((p) => ({
                          sku: p.sku,
                          price: Number(p.price) || null,
                          compareAtPrice: Number(p.compareAtPrice) || null,
                        })),
                      }),
                    "Approved — live on the website",
                  )
                }
              >
                {busy ? "Publishing…" : "Approve & publish at these prices"}
              </button>
            )}
            {l.status === "failed" && (
              <button
                className="btn btn-primary"
                disabled={busy}
                onClick={() =>
                  act(
                    () => api.post(`/seller-listings/${l._id}/retry`),
                    "Queued again",
                  )
                }
              >
                Retry on Shopify
              </button>
            )}
            {!["approved", "rejected"].includes(l.status) && (
              <button className="btn" onClick={() => setRejecting(true)}>
                Reject
              </button>
            )}
            <button className="btn btn-ghost" onClick={onClose}>
              Close
            </button>
          </div>
        )}
      </div>
    </Modal>
  );
}
