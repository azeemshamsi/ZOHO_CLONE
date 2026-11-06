import { useEffect } from "react";
import { Link } from "react-router-dom";
import Logo from "../components/Logo";

// Public page: ordexago.com/privacy — OrdexaGo's privacy policy and how marketplace (Amazon, Shopify) data is handled.

const EFFECTIVE = "7 November 2026";

const S = {
  page: { minHeight: "100vh", background: "var(--bg)", padding: "28px 16px 60px" },
  wrap: { maxWidth: 860, margin: "0 auto" },
  card: { background: "var(--card)", border: "1px solid var(--line)", borderRadius: 12, padding: "28px clamp(18px, 4vw, 44px)", boxShadow: "var(--shadow)", lineHeight: 1.65, fontSize: 15 },
  h2: { fontSize: 19, marginTop: 34, marginBottom: 8 },
  table: { width: "100%", borderCollapse: "collapse", margin: "10px 0 6px", fontSize: 14 },
  th: { textAlign: "left", borderBottom: "2px solid var(--line)", padding: "8px 10px 8px 0", verticalAlign: "top", whiteSpace: "nowrap" },
  td: { borderBottom: "1px solid var(--line-2)", padding: "8px 10px 8px 0", verticalAlign: "top" },
};

function Table({ head, rows }) {
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={S.table}>
        <thead>
          <tr>
            {head.map((h) => (
              <th key={h} style={S.th}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {r.map((c, j) => (
                <td key={j} style={S.td}>
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function Privacy() {
  useEffect(() => {
    document.title = "Privacy Policy · OrdexaGo";
    const h = window.location.hash.slice(1);
    if (h) document.getElementById(h)?.scrollIntoView();
  }, []);
  return (
    <div style={S.page}>
      <div style={S.wrap}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}>
          <Link to="/login" aria-label="OrdexaGo">
            <Logo size={34} />
          </Link>
          <Link to="/login" className="small">
            Sign in
          </Link>
        </div>
        <article style={S.card}>
          <h1 style={{ marginTop: 0, fontSize: 28 }}>Privacy and Data Protection Policy</h1>
          <p className="muted">Effective {EFFECTIVE}</p>
          <p>
            OrdexaGo (ordexago.com) is accounting, order and shipping software for Indian businesses. This policy explains what personal data OrdexaGo handles, why, who it is shared with, how it is protected and how long it is kept. We use personal data only to run the service our subscribers use, and we never sell it or use it for advertising. It follows India's Digital Personal Data Protection Act, 2023 and the DPDP Rules, 2025, and the data protection terms of Amazon and Shopify.
          </p>

          <h2 style={S.h2}>1. Our role</h2>
          <p>
            For the accounts of businesses that subscribe to OrdexaGo and their users, OrdexaGo decides how the data is used and is the <b>Data Fiduciary</b>. For data a subscriber keeps in OrdexaGo about its own customers, vendors, staff, marketplace sellers and online shoppers, the subscriber is the Data Fiduciary and OrdexaGo is its <b>Data Processor</b>: we process that data only on the subscriber's instructions and only to provide the service.
          </p>

          <h2 style={S.h2}>2. What we collect and why</h2>
          <Table
            head={["Data", "Whose", "Used for"]}
            rows={[
              ["Name, email, phone, password (stored only as a bcrypt hash), role, company", "Users of a subscriber's account", "Sign-in, permissions, support, service emails"],
              ["Subscription plan and payments", "Subscribing businesses", "Billing and account status"],
              ["Names, addresses, phones, emails, GSTINs and bank details of customers and vendors", "A subscriber's business contacts", "Invoices, bills, payments and GST returns, as the subscriber directs"],
              ["Buyer name, delivery address, phone, email and items of Shopify and Amazon orders", "A subscriber's online shoppers", "Packing, booking the courier, shipping labels, tracking, tax invoices and returns"],
              ["User accounts, pickup addresses, purchase orders and invoices of marketplace sellers", "Sellers on a subscriber's store", "Seller dashboard, pickups and monthly purchase orders"],
              ["Uploaded bills, bank statements and attachments", "Subscribers", "Bookkeeping; scanned bills are read to fill in the bill"],
              ["Sign-in times, IP address and error logs", "All users", "Security and fixing faults"],
            ]}
          />
          <p>OrdexaGo is a business tool for adults; we do not knowingly collect data about anyone under 18.</p>

          <h2 style={S.h2}>3. Who we share data with</h2>
          <p>Only with the services needed to run OrdexaGo, and only what each needs:</p>
          <Table
            head={["Service", "What it receives", "Location"]}
            rows={[
              ["Oracle Cloud Infrastructure (hosting and database)", "All OrdexaGo data", "Mumbai, India"],
              ["Brevo (email delivery)", "Recipient email address and the email content", "European Union"],
              ["Couriers the subscriber chooses (Blue Dart, Delhivery, DTDC, Shadowfax, Shiprocket)", "Consignee name, address and phone, parcel details, cash-on-delivery amount", "India"],
              ["Shopify and Amazon", "Tracking numbers and shipment status for the subscriber's own orders", "Under their terms"],
              ["GST Suvidha Provider", "Invoice and party details needed for e-invoices, e-way bills and GST returns", "India"],
              ["Google Gemini — only if the subscriber adds its own API key", "The bill being scanned", "Under Google's terms"],
            ]}
          />
          <p>We disclose data to government authorities only when the law requires it. We never sell personal data.</p>

          <h2 style={S.h2} id="amazon">4. Amazon and Shopify customer data</h2>
          <p>When a subscriber connects its Amazon seller account (Selling Partner API) or Shopify store, OrdexaGo receives its buyers' names, delivery addresses and phone numbers. For this data:</p>
          <ul>
            <li>
              <b>Purpose.</b> It is used only to fulfil that buyer's own order: booking the courier, printing the label, delivery, returns and the tax invoice. It is never used for marketing, profiling, selling, or contacting buyers outside the marketplace's own channels, and it is never combined with other sellers' data.
            </li>
            <li>
              <b>Access.</b> Only the seller's own users whose role includes store orders or shipping can see it, each with their own sign-in; shared sign-ins are not allowed. Couriers receive only what is printed on the label.
            </li>
            <li>
              <b>Retention.</b> Amazon buyers' name, address, phone and email are erased from the order, and Amazon's shipping label is deleted, 30 days after the order is delivered, cancelled or returned. Only the order number, items, amounts, city, state and pincode remain, as needed for accounts and GST. Tax invoices keep only the details Indian GST law requires.
            </li>
            <li>
              <b>Protection.</b> Data travels only over HTTPS (TLS 1.2 or higher) and is stored encrypted (AES-256) in Oracle's database in India. Marketplace API secrets are never sent to the browser or shown again after they are saved.
            </li>
            <li>
              <b>No copies.</b> Buyer data is not copied to spreadsheets, email or personal devices, other than the shipping label the courier needs.
            </li>
            <li>
              <b>Incidents.</b> Any security incident that may involve Amazon data is reported to Amazon at security@amazon.com within 24 hours.
            </li>
          </ul>
          <p>Amazon's and Shopify's own data protection terms also apply; where they are stricter than this policy, they prevail.</p>

          <h2 style={S.h2}>5. How we protect data</h2>
          <ul>
            <li>All connections use HTTPS; data at rest and backups are encrypted by Oracle Autonomous Database (AES-256).</li>
            <li>Data is stored in India (Oracle Cloud, Mumbai). Development and testing never use real customer data.</li>
            <li>Every user has their own sign-in; access follows roles, so each person sees only what their job needs. Passwords are stored as one-way hashes.</li>
            <li>Only named OrdexaGo administrators can reach the server or database, by SSH key only, and only to run or repair the service. Access is reviewed every quarter and removed within 24 hours when someone leaves.</li>
            <li>Security updates are applied at least monthly, critical ones within 7 days.</li>
          </ul>

          <h2 style={S.h2}>6. How long we keep data</h2>
          <Table
            head={["Data", "Kept for"]}
            rows={[
              ["Amazon buyers' contact details and labels", "30 days after delivery, cancellation or return"],
              ["Shopify buyers' contact details", "Only as long as needed for delivery, returns and the subscriber's records"],
              ["Invoices, bills, payments, ledgers, GST returns", "8 years from the end of the financial year, as Indian tax and company law require"],
              ["User accounts", "While the account is active"],
              ["Server and security logs", "At least 1 year"],
              ["Database backups", "Up to 60 days, then they expire"],
              ["A closed subscription", "90 days for export, then deleted"],
            ]}
          />

          <h2 style={S.h2}>7. Security incidents</h2>
          <p>
            If personal data may have been exposed, we contain it, inform affected subscribers within 24 hours, Amazon within 24 hours where its data is involved, CERT-In within 6 hours where its rules require, and the Data Protection Board of India and affected individuals as the DPDP Rules require.
          </p>

          <h2 style={S.h2}>8. Your rights</h2>
          <p>
            You can ask to access, correct, update or erase your personal data, withdraw consent, and nominate someone to act for you. If your data is in OrdexaGo because a business you dealt with uses it, please contact that business first; we will help it respond. We reply within 30 days and resolve grievances within 90 days. If you are not satisfied, you may complain to the Data Protection Board of India.
          </p>

          <h2 style={S.h2}>9. Contact and grievance officer</h2>
          <p>
            Grievance Officer, OrdexaGo — <a href="mailto:help@ordexago.com">help@ordexago.com</a>
          </p>

          <h2 style={S.h2}>10. Changes</h2>
          <p>We will publish changes on this page with a new effective date, and email subscribers about any significant change.</p>
        </article>
        <p className="muted small" style={{ textAlign: "center", marginTop: 16 }}>
          © {new Date().getFullYear()} OrdexaGo · <Link to="/login">Sign in</Link>
        </p>
      </div>
    </div>
  );
}
