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
| **Purchase Orders** | Draft → issued → billed/cancelled, expected delivery date, one-click Convert to Bill (prefilled) |
| **Vendor Credits** | From scratch or from a bill, apply to one or many bills, record vendor refunds, void; reduces input tax credit in GSTR-3B |
| **Payments Made** | Pay one or many bills, advance to vendor kept as unused amount, printable voucher |
| **Expenses** | Expense accounts (rent, courier, ads, fuel…), GST inclusive or exclusive, paid through cash/UPI/bank/card, optional vendor |
| **Payments Received** | Cash, UPI, bank, cheque, card; apply to one or many invoices (or auto-apply oldest first); excess kept as customer credit; printable receipt; deleting a payment re-opens the invoices |
| **Banking** | Multiple bank and cash accounts; pick the account on every payment, payment made, expense and refund; import bank statements in Excel (.xlsx, .xls — including the "HTML .xls" files some banks send), CSV, ODS or tab-separated text, as downloaded from net banking (HDFC/ICICI/SBI/Axis/Kotak-style layouts, title rows skipped, separate Debit/Credit or Amount + Dr/Cr columns, dd/mm/yy and "02 Nov 2026" dates, Indian number format, duplicate lines skipped); match lines to MGI transactions or categorise them as expenses/journals in one click; undo. The bank's Balance column is imported and every line's running balance is checked, so a line missing from the file is flagged. Tick lines (or select all) to **bulk** categorise, auto-match, apply rules, exclude or undo. **Transaction Rules**: conditions on description, reference or amount (any/all), withdrawals or deposits, chosen bank accounts, record against any account with optional GST; priority order; test against current lines; run automatically on every import (lines already recorded in MGI on the same day are left to match, never double-counted). **Reconcile** tab: bank reconciliation statement as of any date (balance as per books, uncleared cheques/deposits, bank entries not yet recorded, difference), print, save and history |
| **Chart of Accounts** | Built-in accounts (cash, bank, receivables, payables, input/output CGST-SGST-IGST, sales, COGS, expense accounts, equity) plus your own; balances and every transaction with a running balance |
| **Manual Journals** | Multi-line debit/credit entries that must balance — capital, drawings, opening balances, depreciation, corrections |
| **Reports** | Profit and Loss, Balance Sheet, Trial Balance, Receivables and Payables Ageing, Sales by Customer, Sales by Item, Expenses by Category, GSTR-1 Summary (B2B, B2CL, B2CS, CDNR, CDNUR, HSN), GSTR-3B Summary (outward tax, ITC, net payable). Period presets, print/PDF and CSV export |
| **Settings** | Organization name, GSTIN, state, address, contact details, number prefixes, default terms and notes |

## Roadmap

- **Phase 2 – Sales:** ✅ Quotes, Sales Orders, Credit Notes. Still to come: Delivery Challans, recurring invoices, emailing invoices to customers
- **Phase 3 – Purchases:** ✅ Vendors, Purchase Orders, Bills, Expenses, Payments Made, Vendor Credits
- **Phase 4 – Accountant & Reports:** ✅ Chart of accounts, manual journals, P&L, Balance Sheet, Trial Balance, ageing, sales and expense reports, GSTR-1/GSTR-3B summaries. ✅ Banking with statement import, matching and categorisation
- **Next:** Emailing invoices/quotes, recurring invoices, inventory tracking, multiple users & roles, Shopify sync

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

## How the books work

Every invoice, payment, credit note, bill, payment made, expense and manual journal is turned into balanced double-entry postings when a report is opened (`backend/src/utils/ledger.js`). Nothing is stored twice, so reports always match the documents. Drafts and void documents never post.

## Tests

```bash
npm test   # GST calculation tests
```

## Reports Center

The Reports Center (Reports in the sidebar) works like Zoho's. It has a category sidebar, search, starred favourites and a "last visited" time for each report. It holds 43 reports:

- **Business Overview:** Profit and Loss (standard, Schedule III and horizontal), Cash Flow Statement (indirect method), Balance Sheet (standard, Schedule III and horizontal), Business Performance Ratios, Movement of Equity
- **Sales:** by customer, by item, monthly summary
- **Receivables:** customer balances, AR ageing summary and details, invoice, quote, sales order and credit note details
- **Payments Received**
- **Payables:** vendor balances, AP ageing summary and details, bill, purchase order and vendor credit details, payments made
- **Purchases and Expenses:** by vendor, by item and by category, expenses by vendor, expense details
- **Taxes:** GSTR-1, GSTR-3B, tax summary by rate
- **Banking:** reconciliation status
- **Accountant:** account transactions, account type summary, general ledger and detailed general ledger, journal report, day book, trial balance

Every report has date filters, CSV export and print/PDF. The new reports live in `backend/src/utils/reportCatalog.js` and are served at `GET /api/reports/:key`.
