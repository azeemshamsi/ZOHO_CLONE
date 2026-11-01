# OrdexaGo — GST-ready accounting

<img src="frontend/public/logo-full.png" alt="OrdexaGo" width="320" />

OrdexaGo is a web accounting app for Indian businesses, modelled on the feature set of full accounting suites like Zoho Books, with its own name, design and logo.

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
| **Banking** | Multiple bank and cash accounts; pick the account on every payment, payment made, expense and refund; import bank statements in Excel (.xlsx, .xls — including the "HTML .xls" files some banks send), CSV, ODS or tab-separated text, as downloaded from net banking (HDFC/ICICI/SBI/Axis/Kotak-style layouts, title rows skipped, separate Debit/Credit or Amount + Dr/Cr columns, dd/mm/yy and "02 Nov 2026" dates, Indian number format, duplicate lines skipped); match lines to OrdexaGo transactions or categorise them as expenses/journals in one click; undo. The bank's Balance column is imported and every line's running balance is checked, so a line missing from the file is flagged. Tick lines (or select all) to **bulk** categorise, auto-match, apply rules, exclude or undo. **Transaction Rules**: conditions on description, reference or amount (any/all), withdrawals or deposits, chosen bank accounts, record against any account with optional GST; priority order; test against current lines; run automatically on every import (lines already recorded in OrdexaGo on the same day are left to match, never double-counted). **Reconcile** tab: bank reconciliation statement as of any date (balance as per books, uncleared cheques/deposits, bank entries not yet recorded, difference), print, save and history |
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
| `BREVO_API_KEY` or `RESEND_API_KEY`, with `MAIL_FROM` | No | Server email (password resets, verification, and documents for organizations without their own email settings) over HTTPS. Use this on Render's free plan |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` | No | The same over SMTP (needs a paid Render instance: the free plan blocks SMTP ports) |
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

The Reports Center (Reports in the sidebar) works like Zoho's. It has a category sidebar, search, starred favourites and a "last visited" time for each report. It holds 55 reports:

- **Business Overview:** Profit and Loss (standard, Schedule III and horizontal), Cash Flow Statement (indirect method), Balance Sheet (standard, Schedule III and horizontal), Business Performance Ratios, Movement of Equity
- **Sales:** by customer, by item, monthly summary
- **Receivables:** customer balances, AR ageing summary and details, invoice, quote, sales order and credit note details
- **Payments Received**
- **Payables:** vendor balances, AP ageing summary and details, bill, purchase order and vendor credit details, payments made
- **Purchases and Expenses:** by vendor, by item and by category, expenses by vendor, expense details
- **Taxes:** GSTR-1, GSTR-3B, tax summary by rate
- **Banking:** reconciliation status
- **Inventory:** inventory summary, inventory valuation (FIFO), FIFO cost lot tracking, stock movement, product sales with margin, committed stock, reorder report
- **Projects and Timesheet:** project summary, timesheet details, unbilled time
- **Recurring:** recurring profiles
- **Activity:** emails sent
- **Accountant:** account transactions, account type summary, general ledger and detailed general ledger, journal report, day book, trial balance

Every report has date filters, CSV export and print/PDF. The new reports live in `backend/src/utils/reportCatalog.js` and are served at `GET /api/reports/:key`.

## Inventory

To track stock for an item, switch on **Track inventory** on the item and enter its opening stock and reorder level.

- **Stock in:** bills and sales returns (credit notes).
- **Stock out:** invoices and returns to vendors (vendor credits).
- **Adjustments:** Items → Inventory Adjustments records stocktakes, damage and revaluations.
- **Costing:** stock is costed FIFO. The **Inventory Asset** account always equals the stock value, and the cost of what's sold moves to Cost of Goods Sold.

The engine is `backend/src/utils/inventory.js`.

## Recurring invoices, bills and expenses

A recurring profile repeats daily, weekly, monthly or yearly, every N periods, with an optional end date. Documents can be created as drafts or as final (sent or open).

An hourly scheduler creates whatever is due. On hosts that sleep, such as Render's free plan, anything missed is caught up when the app wakes or a recurring list is opened.

## Users and roles

From Users & Roles you can invite people by link or email. Built-in roles: Admin, Accountant, Staff, Sales Staff, Warehouse, Returns Scanner and View Only. **New Role** creates your own: for each module (Sales, Purchases, Items, Inventory, Banking, Accountant, Reports, GST, Store orders, Store shipping, Store returns, Store settings, Settings) choose No access, View or Full, and the page the user opens on. A user only sees the menu items their role allows, and every API route checks the same permissions (`backend/src/utils/roles.js`, `models/Role.js`). Example: a "Returns Scanner" role opens straight on Scan Returns and can't reach invoices, reports or anything else.

## Several companies

One login can belong to several companies (`models/Membership.js`), with a different role in each. Switch from the company name at the top left, or add a new company there. The chosen company is sent with every request in the `X-Org` header.

A store connected in one company can be **shared** with your other companies (Store Settings → Share). Every company sharing the store sees the same orders, and an invoice made from an order is created in the company you're working in, so some orders can be billed from one company and others from another. The list shows which company invoiced each order. Shipping, courier accounts and the inventory sync stay with the company that owns the store.

## Attachments and bills from PDF

Every invoice, quote, sales order, credit note, bill, purchase order, vendor credit, payment, payment made, journal and expense has an **Attachments** box: upload PDFs, images, Excel or Word files (up to 10 MB each; on a phone you can take a photo). Files are stored in MongoDB GridFS, so they survive redeploys, and open from the box at any time.

**From bill PDF** (Bills and Expenses lists) reads a supplier's bill and fills in a new bill or expense: supplier and GSTIN (matched to an existing vendor or created), bill number, dates, place of supply, HSN, taxable value, GST rate and total. You check the figures and save; the PDF is attached automatically. It works on PDFs with a text layer (e-invoices and system-generated bills). Scanned images are attached and you type the amounts (`utils/billparse.js`, `routes/billScan.js`).

## GST returns and compliance

**GST → GST Returns** (`/gst`):

- **Compliance calendar** for the financial year: GSTR-1, GSTR-3B (monthly or quarterly QRMP, with the 22nd/24th due date for your state), IFF, PMT-06, GSTR-9 and 9C, TDS payments and returns, advance tax and ITR, with Overdue / Due soon / Filed status. Mark a return as filed with its ARN.
- **GSTR-1**: B2B, B2C large, B2C small, exports, credit notes (registered and unregistered), nil-rated, HSN summary (B2B and B2C) and documents issued, with a list of problems to fix (missing HSN, invalid GSTIN, missing place of supply). **Download JSON** in the GST portal's offline-tool format.
- **GSTR-3B**: 3.1 outward supplies, 3.2 inter-state supplies to unregistered persons, 4 eligible ITC (from the books or as per the uploaded GSTR-2B), 5 exempt inward supplies, and 6.1 payment of tax with credit set off in the legal order (IGST first; CGST and SGST never against each other), cash to pay and credit carried forward. Download JSON.
- **GSTR-9**: annual working figures (tables 4, 5, 6–7, 9, 17 and 18 HSN) on screen and as an Excel download.

**GST → GSTR-2B Reconciliation** (`/gst/reconcile`): upload the GSTR-2B JSON or Excel (or the older GSTR-2A JSON) from the portal. Each supplier document is matched against your bills, expenses and vendor credits by GSTIN and bill number (ignoring punctuation and leading zeros), or by amount and date when the number differs: Matched, Probable match, Mismatch (values differ), Not in books (record the bill in one click) and Not in GSTR-2B (ITC at risk — follow up with the supplier). Accept a difference to treat it as matched. The 2B ITC total can be used in GSTR-3B.

Filing itself happens on gst.gov.in by uploading the JSON (Prepare offline → Upload), which takes a minute. Filing from inside OrdexaGo through the GST API would need a GST Suvidha Provider (GSP) licence. Code: `utils/gstReturns.js`, `routes/gstReturns.js`.

## Mobile and installing the app

OrdexaGo is a web app that works on phones: lists, invoices, bills and the invoice form switch to a card layout on small screens. On Android (Chrome → Add to Home screen / Install app) or iPhone (Safari → Share → Add to Home Screen) it installs like an app, with shortcuts for New Invoice, Scan Returns and Store Orders (`frontend/public/sw.js`, `manifest.webmanifest`). Data always comes live from the server.

## Email

Documents are emailed as PDFs made on the server, sent from the organization's email account (Settings → Email). **Brevo** or **Resend** send over HTTPS and work on Render's free plan. Gmail, Zoho Mail, Outlook or other SMTP need outbound SMTP, which Render's free plan blocks. Automatic payment reminders can be switched on under Settings → Payment Reminders.

## Projects and timesheets

Projects can be billed four ways:

- a fixed fee
- a project hourly rate
- a rate per task
- a rate per person

Log time by hand or with the timer, then **Invoice Project** to turn unbilled time into a draft invoice.

## Budgets

Accountant → Budgets: monthly, quarterly or yearly budgets per account for a financial year, with **Budget vs Actuals** (variance and % achieved per period).

## Fixed assets

Accountant → Fixed Assets: assets with Written Down Value (Income Tax) or Straight Line (Companies Act) depreciation, posted monthly (`backend/src/utils/assets.js`). Selling or writing off an asset posts the gain or loss. Reports: Fixed Asset Register, Depreciation Schedule.

## Branches and warehouses

- **Branches** have their own GSTIN, state and address. Documents carry the branch, GST follows the branch's state, PDFs show its GSTIN, and every report has a branch filter (`config/branchScope.js`).
- **Warehouses** track stock per location. Transfer Orders move stock between them; Warehouse Stock Summary report.

## Multiple currencies

Settings → Currencies holds foreign currencies with ₹ rates. A customer or vendor can use one of them; its invoices, bills and payments are then in that currency at a per-document rate.

The books and all reports stay in ₹ (`config/baseCurrency.js` converts documents for reports). Differences between invoice and payment rates are posted to "Exchange Loss / (Gain)".

## Branch number series

Give a branch its own prefixes (Branches & Warehouses → edit branch → Number Series) and its invoices, credit notes, payments, quotes, orders and vendor documents get a separate series (e.g. `DL/INV-000001`).

## Exchange rates and revaluation

- **Rates:** Currencies → **Fetch Latest Rates** (or "Update rates daily") pulls ₹ rates from open.er-api.com (override with `FX_API_URL`).
- **Revaluation:** **Exchange Rate Adjustments** revalue unpaid foreign invoices and bills at a closing rate (e.g. 31 March). The result posts to "Unrealised Exchange Loss / (Gain)" and is reversed the next day.

## e-Invoicing and e-Way Bills

Turn them on under Sales → e-Invoices / e-Way Bills.

1. OrdexaGo builds the government JSON (e-invoice schema INV-01 v1.1, and the e-way bill bulk format 1.0.0421) and checks it against the portal rules (`backend/src/utils/einvoice.js`).
2. Upload the file on the e-invoice portal (Bulk Upload) or the e-way bill portal (Generate Bulk).
3. Record the IRN, Ack No and signed QR (or upload the portal's response file), or the e-way bill number.

The QR code, IRN and e-way bill number then print on the invoice and PDF. An invoice with a live IRN is locked until its e-invoice is cancelled.

Generating directly through the API needs a GST Suvidha Provider (GSP) account; the JSON upload route needs nothing extra.

## Importing from Zoho Books and Tally

Settings → **Import Data** (`/import`, needs the Settings permission) brings over a chart of accounts, customers (debtors), vendors (creditors), opening balances and transactions.

- **Formats:** Excel (.xlsx, .xls, .ods, Excel 2003 XML), CSV/TSV (UTF-8 or UTF-16), and XML: Tally's XML (Data Interchange) exports, plus any XML with repeated records.
- **Zoho Books:** the module exports (Chart of Accounts, Contacts/Vendors, Invoice, Bill, Credit Note, Vendor Credits, Customer Payment, Vendor Payment, Expense, Journal) and the Trial Balance for opening balances. Column names are recognised automatically, and a workbook may hold several sheets.
- **Tally ERP 9 / TallyPrime:** masters (groups and ledgers, with opening balances and bill-wise outstanding) and Day Book vouchers. Sales and Purchase vouchers become invoices and bills, Credit and Debit Notes become credit notes and vendor credits, Receipts and Payments against parties become payments (settled bill-wise against "Agst Ref", otherwise against the oldest open documents), and everything else becomes a journal. Excel exports of the ledger list or trial balance work too. Cancelled and optional vouchers are skipped.
- **Opening balances** post on the opening balance date against Opening Balance Equity. Customer and vendor balances come in as opening invoices and bills (bill-wise where Tally has the bills), so ageing and payments work. These are flagged `opening` and kept out of sales, purchase and GST reports.
- **Safe to repeat:** every imported record carries an `importRef`. Re-importing the same file skips what's already there.
- Documents are created through OrdexaGo's own routes (`utils/import/commit.js`), so GST, numbering and settlement are the same as when they're entered by hand. If a total differs from the source (mixed rates, round-off, freight), the difference goes into the Adjustment and a warning is shown.
- Code: `utils/import/parse.js` (files), `sheets.js` (column detection and Zoho/spreadsheet mapping), `tally.js` (Tally XML), `commit.js`, `routes/import.js`. CSV templates are available on the page.

## Store (Shopify orders and shipping)

**Store** in the sidebar, set up under **Store Settings** (`/shopify-settings`). An invoice made from an order carries the Shopify order number in its Reference# field.

- **Connection:** a Dev Dashboard app (Client ID and secret; OrdexaGo gets and renews the 24-hour token with Shopify's client credentials grant) or an older custom app's `shpat_` token. Scopes: `read_orders`, `read_all_orders`, `read_products`, `read_customers`, `read_inventory`, plus `write_merchant_managed_fulfillment_orders` to mark orders fulfilled from OrdexaGo. Orders sync through the Admin GraphQL API, on demand and every 15 minutes (`utils/shopify/sync.js`).
- **Order tabs:** New, Packed, Ready to Ship, Shipped, Delivered, RTO, Cancelled and All, with counts. Filters: search (order number, customer, phone, email, AWB, SKU, pincode, city, invoice number), date range, COD/prepaid, payment status, state, courier, invoiced, tag and sort. The filtered list exports to CSV. Cancellations and fulfilments done in Shopify update the status.
- **Items:** each product becomes an item, with the price taken back out of GST. Category rules (editable; defaults are furniture 18%, kitchenware, home decor and home furnishing 5%) set the GST rate and replace a missing, invalid or wrong-category HSN with the category's default. Changes are flagged under **Review items**. Existing items keep their HSN and rate (`utils/shopify/catalog.js`).
- **Payment types:** prepaid, COD, and partly paid (part paid online, the rest collected on delivery), worked out from the order's payment gateways and transactions. The COD amount sent to the courier is only the unpaid part.
- **One-click invoices** (optional, single or bulk), shown under Invoices and in every report. Invoices carry both Bill To and Ship To: customer matched by email or phone, otherwise created. Place of supply comes from the shipping state. Discounts go on the lines, shipping becomes a line at the order's highest GST rate, and any rounding goes into Adjustment so the total equals Shopify's. Optionally, a payment is recorded for paid prepaid orders (`utils/shopify/invoice.js`).
- **Couriers** (`utils/couriers`): Shiprocket (order, AWB, label, pickup, tracking, cancel), Delhivery (manifest, label, tracking, cancel), Blue Dart (JWT, waybill with label, cancel), DTDC (Shipsy softdata, label, cancel; tracking with separate tracking credentials), Shadowfax (marketplace API), and custom couriers (a stock of AWB numbers used in order, or typed in when booking, optionally limited to certain pincodes). Each account sets whether it takes COD, its label format (4x6 or A4, four per page) and a line of text printed on labels. Each account can use the courier's test system or a different API address. OrdexaGo also prints its own 4x6" labels with barcodes, for one order or many. Tracking refreshes every 2 hours, moving orders to Shipped, Delivered or RTO.

## Inventory, racks and Shopify inventory sync

**Items → Inventory** (`/inventory`). Tabs: All, In Stock, Out of Stock, Virtual Stock and Over Sold. Search covers SKU, name, HSN, rack and linked SKU, and you can filter by category, rack and sync status. Export to CSV.

- **Racks:** add racks (bins) to a warehouse, one by one or as a range like `A01-A20`. Stock is put away into racks and moved between them; each move is recorded with who made it. Sales take stock off racks automatically, starting with the first rack. Shopify orders show which rack to pick from. Racks are only a location layer: the books still work by warehouse (`utils/stockview.js`, `models/Rack.js`, `models/RackMove.js`).
- **Blocked:** Shopify orders hold stock until they are invoiced (orders from the date set in Shopify Settings). The invoice then becomes the actual stock-out. Cancelled, RTO and returned orders release the stock.
- **Buffer** is kept back from Shopify. **Virtual stock** is made-to-order quantity shown on Shopify; it never enters the books.
- **Shopify quantity** = in stock − blocked − buffer + virtual. Orders beyond the free stock use up the virtual quantity.
- **Linked listings:** link any number of Shopify listings to one OrdexaGo item (e.g. four listings of one metal table). Their orders use that item's stock, and its stock is pushed to all of them. A listing's auto-created item is retired, and its open orders move to the main item.
- **Sync** (`utils/shopify/inventory.js`): any change to invoices, bills, credit notes, adjustments, transfers, Shopify orders or item settings triggers a push a few seconds later (a mongoose plugin, `utils/shopify/stockPlugin.js`). It uses `inventorySetQuantities` with an idempotency key and `changeFromQuantity: null`, as API 2026-04+ requires, and only sends quantities that changed. A full check runs every 30 minutes, and there's a manual push. Each item has its own sync on/off switch. Order webhooks (orders/create and orders/updated, verified by HMAC) bring new orders in within seconds, so reservations are up to date.
- **Returns:** Mark Return Created / Mark Return Closed on Shopify orders, mirrored in Shopify with `returnCreate` / `returnClose`. **Shopify → Scan Returns** (`/returns-scan`) is built for phones: scan the AWB or order number with the camera (ZXing), a barcode scanner or the keyboard. Closing a return on an invoiced order makes a credit note, so the stock comes back.
- New items from Shopify have inventory tracking on. Scopes needed for this part: `write_inventory`, `read_locations`, `read_returns`, `write_returns`.
- On phones, order and inventory lists turn into cards and dialogs open full screen.
