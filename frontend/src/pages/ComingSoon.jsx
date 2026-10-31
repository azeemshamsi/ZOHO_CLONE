import { useLocation, Link } from "react-router-dom";
import { Empty } from "../components/ui";

const NAMES = {
  "/quotes": "Quotes",
  "/sales-orders": "Sales Orders",
  "/credit-notes": "Credit Notes",
  "/purchase-orders": "Purchase Orders",
  "/vendor-credits": "Vendor Credits",
  "/banking": "Banking",
  "/journals": "Manual Journals",
  "/chart-of-accounts": "Chart of Accounts",
  "/reports": "Reports",
};

export default function ComingSoon() {
  const { pathname } = useLocation();
  const name = NAMES[pathname] || "This module";
  return (
    <Empty
      icon="chart"
      title={`${name} is coming soon`}
      text="It's part of the next phases of MGI. Sales, Purchases, Accountant and Reports are ready to use today."
      action={
        <Link to="/invoices" className="btn btn-primary">
          Go to Invoices
        </Link>
      }
    />
  );
}
