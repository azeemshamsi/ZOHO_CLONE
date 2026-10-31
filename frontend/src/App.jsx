import { Navigate, Route, Routes } from "react-router-dom";
import { useAuth } from "./lib/auth";
import Layout from "./components/Layout";
import { Spinner, Toaster } from "./components/ui";
import { Login, Signup, ForgotPassword, ResetPassword, VerifyEmail } from "./pages/Auth";
import Dashboard from "./pages/Dashboard";
import { CustomerList, CustomerForm, CustomerDetail } from "./pages/Customers";
import { ItemList, ItemForm } from "./pages/Items";
import { InvoiceList, InvoiceForm, InvoiceView } from "./pages/Invoices";
import { PaymentList, PaymentForm, PaymentView } from "./pages/Payments";
import { QuoteList, QuoteForm, QuoteView } from "./pages/Quotes";
import { SalesOrderList, SalesOrderForm, SalesOrderView } from "./pages/SalesOrders";
import { CreditNoteList, CreditNoteForm, CreditNoteView } from "./pages/CreditNotes";
import { VendorList, VendorForm, VendorDetail } from "./pages/Vendors";
import { BillList, BillForm, BillView } from "./pages/Bills";
import { VendorPaymentList, VendorPaymentForm, VendorPaymentView } from "./pages/VendorPayments";
import { ExpenseList, ExpenseForm } from "./pages/Expenses";
import { AccountList, AccountDetail } from "./pages/Accounts";
import { JournalList, JournalForm, JournalView } from "./pages/Journals";
import { ReportsHome, ReportPage } from "./pages/Reports";
import { PurchaseOrderList, PurchaseOrderForm, PurchaseOrderView } from "./pages/PurchaseOrders";
import { VendorCreditList, VendorCreditForm, VendorCreditView } from "./pages/VendorCredits";
import { BankingHome, BankAccountPage } from "./pages/Banking";
import Settings from "./pages/Settings";
import ComingSoon from "./pages/ComingSoon";

function Private({ children }) {
  const { loading, user } = useAuth();
  if (loading) return <Spinner />;
  return user ? children : <Navigate to="/login" replace />;
}

function PublicOnly({ children }) {
  const { loading, user } = useAuth();
  if (loading) return <Spinner />;
  return user ? <Navigate to="/" replace /> : children;
}

const SOON = [];

export default function App() {
  return (
    <>
      <Routes>
        <Route path="/login" element={<PublicOnly><Login /></PublicOnly>} />
        <Route path="/signup" element={<PublicOnly><Signup /></PublicOnly>} />
        <Route path="/forgot-password" element={<ForgotPassword />} />
        <Route path="/reset-password/:id/:token" element={<ResetPassword />} />
        <Route path="/verify/:id/:token" element={<VerifyEmail />} />

        <Route element={<Private><Layout /></Private>}>
          <Route index element={<Dashboard />} />
          <Route path="customers" element={<CustomerList />} />
          <Route path="customers/new" element={<CustomerForm />} />
          <Route path="customers/:id" element={<CustomerDetail />} />
          <Route path="customers/:id/edit" element={<CustomerForm />} />
          <Route path="items" element={<ItemList />} />
          <Route path="items/new" element={<ItemForm />} />
          <Route path="items/:id/edit" element={<ItemForm />} />
          <Route path="invoices" element={<InvoiceList />} />
          <Route path="invoices/new" element={<InvoiceForm />} />
          <Route path="invoices/:id" element={<InvoiceView />} />
          <Route path="invoices/:id/edit" element={<InvoiceForm />} />
          <Route path="quotes" element={<QuoteList />} />
          <Route path="quotes/new" element={<QuoteForm />} />
          <Route path="quotes/:id" element={<QuoteView />} />
          <Route path="quotes/:id/edit" element={<QuoteForm />} />
          <Route path="sales-orders" element={<SalesOrderList />} />
          <Route path="sales-orders/new" element={<SalesOrderForm />} />
          <Route path="sales-orders/:id" element={<SalesOrderView />} />
          <Route path="sales-orders/:id/edit" element={<SalesOrderForm />} />
          <Route path="credit-notes" element={<CreditNoteList />} />
          <Route path="credit-notes/new" element={<CreditNoteForm />} />
          <Route path="credit-notes/:id" element={<CreditNoteView />} />
          <Route path="credit-notes/:id/edit" element={<CreditNoteForm />} />
          <Route path="vendors" element={<VendorList />} />
          <Route path="vendors/new" element={<VendorForm />} />
          <Route path="vendors/:id" element={<VendorDetail />} />
          <Route path="vendors/:id/edit" element={<VendorForm />} />
          <Route path="bills" element={<BillList />} />
          <Route path="bills/new" element={<BillForm />} />
          <Route path="bills/:id" element={<BillView />} />
          <Route path="bills/:id/edit" element={<BillForm />} />
          <Route path="payments-made" element={<VendorPaymentList />} />
          <Route path="payments-made/new" element={<VendorPaymentForm />} />
          <Route path="payments-made/:id" element={<VendorPaymentView />} />
          <Route path="expenses" element={<ExpenseList />} />
          <Route path="expenses/new" element={<ExpenseForm />} />
          <Route path="expenses/:id/edit" element={<ExpenseForm />} />
          <Route path="chart-of-accounts" element={<AccountList />} />
          <Route path="chart-of-accounts/:code" element={<AccountDetail />} />
          <Route path="journals" element={<JournalList />} />
          <Route path="journals/new" element={<JournalForm />} />
          <Route path="journals/:id" element={<JournalView />} />
          <Route path="journals/:id/edit" element={<JournalForm />} />
          <Route path="reports" element={<ReportsHome />} />
          <Route path="reports/:key" element={<ReportPage />} />
          <Route path="purchase-orders" element={<PurchaseOrderList />} />
          <Route path="purchase-orders/new" element={<PurchaseOrderForm />} />
          <Route path="purchase-orders/:id" element={<PurchaseOrderView />} />
          <Route path="purchase-orders/:id/edit" element={<PurchaseOrderForm />} />
          <Route path="vendor-credits" element={<VendorCreditList />} />
          <Route path="vendor-credits/new" element={<VendorCreditForm />} />
          <Route path="vendor-credits/:id" element={<VendorCreditView />} />
          <Route path="vendor-credits/:id/edit" element={<VendorCreditForm />} />
          <Route path="banking" element={<BankingHome />} />
          <Route path="banking/:code" element={<BankAccountPage />} />
          <Route path="payments" element={<PaymentList />} />
          <Route path="payments/new" element={<PaymentForm />} />
          <Route path="payments/:id" element={<PaymentView />} />
          <Route path="settings" element={<Settings />} />
          {SOON.map((p) => (
            <Route key={p} path={p.slice(1)} element={<ComingSoon />} />
          ))}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
      <Toaster />
    </>
  );
}
