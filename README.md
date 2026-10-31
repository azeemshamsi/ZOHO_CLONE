# MGI — GST-ready accounting

MGI is a web accounting app for Indian businesses, modelled on the feature set of full accounting suites like Zoho Books, with its own name, design and logo.

Built with MongoDB, Express, React (Vite) and Node.js. One Node server runs the API and serves the web app.

## What's in it today

| Module | Features |
| --- | --- |
| **Accounts** | Sign up (creates your organization), sign in, forgot/reset password, optional email verification |
| **Home** | Total payables (current/overdue), top expenses this financial year, total receivables with current/overdue ageing (1–15, 16–30, 31–45, 45+ days), 12-month sales vs receipts chart, financial-year totals, top customers by dues, recent invoices |
| **Customers** | Business/individual, GST treatment, GSTIN (auto-sets place of supply), billing & shipping address, payment terms, receivables, transaction history |
| **Items** | Goods/services, HSN/SAC, unit, selling & cost price, GST rate (0–28%) |
| **Invoices** | Auto numbering, payment terms → due date, line items with discount, **CGST + SGST for intra-state or IGST for inter-state** worked out automatically, shipping & adjustment, draft/sent, unpaid/partially paid/paid/overdue/void, printable tax invoice with amount in words (Print → Save as PDF) |
| **Quotes** | Draft → sent → accepted/declined, expiry date (shows Expired), one-click convert to Sales Order or Invoice |
| **Sales Orders** | Draft → confirmed → invoiced, expected shipment date, cancel/reopen, one-click convert to Invoice |
| **Credit Notes** | From scratch or from an invoice, GST reasons, apply credit to one or many invoices, refund, remove an application, void |
| **Vendors** | GST treatment, GSTIN (fills source of supply and PAN), payment terms, payables, bills/payments/expenses history |
| **Bills** | Vendor's bill number (duplicates blocked), cost prices from items, input GST (CGST+SGST or IGST from the vendor's state), draft/open/partially paid/paid/overdue/void |
| **Payments Made** | Pay one or many bills, advance to vendor kept as unused amount, printable voucher |
| **Expenses** | Expense accounts (rent, courier, ads, fuel…), GST inclusive or exclusive, paid through cash/UPI/bank/card, optional vendor |
| **Payments Received** | Cash, UPI, bank, cheque, card; apply to one or many invoices (or auto-apply oldest first); excess kept as customer credit; printable receipt; deleting a payment re-opens the invoices |
| **Settings** | Organization name, GSTIN, state, address, contact details, number prefixes, default terms and notes |

## Roadmap

- **Phase 2 – Sales:** ✅ Quotes, Sales Orders, Credit Notes. Still to come: Delivery Challans, recurring invoices, emailing invoices to customers
- **Phase 3 – Purchases:** ✅ Vendors, Bills, Expenses, Payments Made. Still to come: Purchase Orders, Vendor Credits
- **Phase 4 – Accountant & Reports:** Chart of accounts, manual journals, banking, P&L, Balance Sheet, GSTR-1/GSTR-3B summaries, aging reports
- **Later:** Inventory tracking, multiple users & roles, Shopify sync

These modules already appear in the sidebar marked **Soon**.

## Deploy on Render (free)

### 1. Create a free MongoDB database (MongoDB Atlas)
1. Sign up at <https://www.mongodb.com/cloud/atlas/register> and create a **free M0 cluster** (choose the Mumbai region).
2. **Database Access** → add a database user with a password.
3. **Network Access** → *Add IP Address* → **Allow access from anywhere** (`0.0.0.0/0`). Render's free servers don't have fixed IPs.
4. **Connect** → *Drivers* → copy the connection string. Put your password in it and add the database name `mgi` before the `?`:
   `mongodb+srv://myuser:mypassword@cluster0.abcde.mongodb.net/mgi?retryWrites=true&w=majority`

### 2. Deploy the app
1. Sign in at <https://render.com> with GitHub.
2. **New → Blueprint**, pick this repository. Render reads `render.yaml`.
3. When asked, paste the **MONGODB_URI** from step 1. Leave the email fields blank for now. `JWT_SECRET` is generated for you.
4. Click **Apply**. The first build takes 3–5 minutes. Your app will be at `https://mgi-xxxx.onrender.com`.
5. Open the service → **Environment** → set **APP_URL** to that address (used in password-reset emails) and save.

Every push to `main` redeploys automatically.

> Free Render services sleep after 15 minutes without visitors, so the first page load after a break takes about 30–50 seconds. The $7/month Starter plan keeps it awake.

### Optional: password-reset emails (Gmail)
1. Turn on 2-Step Verification for your Google account, then create an **App Password** at <https://myaccount.google.com/apppasswords>.
2. In Render → Environment, set `SMTP_USER` to your Gmail address and `SMTP_PASS` to the 16-character app password.
3. To make new users verify their email before logging in, also set `REQUIRE_EMAIL_VERIFICATION=true`.

## Run on your computer

Needs Node.js 20+ and a MongoDB connection string (Atlas works).

```bash
cp backend/.env.example backend/.env   # then fill in MONGODB_URI
npm install --prefix backend
npm install --prefix frontend
npm run dev:backend    # API on http://localhost:8080
npm run dev:frontend   # app on http://localhost:5173
```

Or with Docker: `docker compose up`, then open <http://localhost:8080>.

## Environment variables

| Name | Required | Purpose |
| --- | --- | --- |
| `MONGODB_URI` | Yes | MongoDB connection string |
| `JWT_SECRET` | Yes (production) | Long random string that signs login sessions |
| `APP_URL` | Recommended | Public address of the app, used in email links |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` | No | Outgoing email for password resets |
| `REQUIRE_EMAIL_VERIFICATION` | No | `true` to make new users verify their email |

## Project layout

```
backend/   Express API (src/routes, src/models), serves frontend/dist in production
frontend/  React app built with Vite
render.yaml  Render deployment blueprint
Dockerfile   Container build for any other host
```

## Tests

```bash
npm test   # GST calculation tests
```
