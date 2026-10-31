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

const SOON = ["/quotes", "/sales-orders", "/credit-notes", "/vendors", "/expenses", "/bills", "/payments-made", "/banking", "/journals", "/chart-of-accounts", "/reports"];

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
