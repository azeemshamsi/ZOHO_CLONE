// Settings for each kind of sales document. The shared form, list and print view read these.
export const KINDS = {
  invoice: {
    key: "invoice",
    label: "Invoice",
    plural: "Invoices",
    api: "/invoices",
    route: "/invoices",
    numberField: "invoiceNumber",
    numberLabel: "Invoice#",
    dateLabel: "Invoice Date",
    refField: "orderNumber",
    refLabel: "Order Number",
    second: { field: "dueDate", label: "Due Date", required: true, terms: true },
    docTitle: "TAX INVOICE",
    saveButtons: [
      { status: "draft", label: "Save as Draft" },
      { status: "sent", label: "Save and Mark as Sent", primary: true },
    ],
  },
  quote: {
    key: "quote",
    label: "Quote",
    plural: "Quotes",
    api: "/quotes",
    route: "/quotes",
    numberField: "number",
    numberLabel: "Quote#",
    dateLabel: "Quote Date",
    refField: "reference",
    refLabel: "Reference#",
    second: { field: "expiryDate", label: "Expiry Date", defaultDays: 15 },
    docTitle: "QUOTE",
    saveButtons: [
      { status: "draft", label: "Save as Draft" },
      { status: "sent", label: "Save and Mark as Sent", primary: true },
    ],
  },
  salesOrder: {
    key: "salesOrder",
    label: "Sales Order",
    plural: "Sales Orders",
    api: "/sales-orders",
    route: "/sales-orders",
    numberField: "number",
    numberLabel: "Sales Order#",
    dateLabel: "Sales Order Date",
    refField: "reference",
    refLabel: "Reference#",
    second: { field: "shipmentDate", label: "Expected Shipment Date" },
    docTitle: "SALES ORDER",
    saveButtons: [
      { status: "draft", label: "Save as Draft" },
      { status: "confirmed", label: "Save and Confirm", primary: true },
    ],
  },
  creditNote: {
    key: "creditNote",
    label: "Credit Note",
    plural: "Credit Notes",
    api: "/credit-notes",
    route: "/credit-notes",
    numberField: "number",
    numberLabel: "Credit Note#",
    dateLabel: "Credit Note Date",
    refField: "reference",
    refLabel: "Reference#",
    second: null,
    docTitle: "CREDIT NOTE",
    saveButtons: [
      { status: "draft", label: "Save as Draft" },
      { status: "open", label: "Save as Open", primary: true },
    ],
  },
};

// Purchase documents (party = vendor)
KINDS.bill = {
  key: "bill",
  party: "vendor",
  label: "Bill",
  plural: "Bills",
  api: "/bills",
  route: "/bills",
  numberField: "billNumber",
  numberLabel: "Bill#",
  numberAuto: false,
  dateLabel: "Bill Date",
  refField: "orderNumber",
  refLabel: "Order Number",
  second: { field: "dueDate", label: "Due Date", required: true, terms: true },
  docTitle: "BILL",
  saveButtons: [
    { status: "draft", label: "Save as Draft" },
    { status: "open", label: "Save as Open", primary: true },
  ],
};

KINDS.purchaseOrder = {
  key: "purchaseOrder",
  party: "vendor",
  label: "Purchase Order",
  plural: "Purchase Orders",
  api: "/purchase-orders",
  route: "/purchase-orders",
  numberField: "number",
  numberLabel: "Purchase Order#",
  dateLabel: "Purchase Order Date",
  refField: "reference",
  refLabel: "Reference#",
  second: { field: "deliveryDate", label: "Expected Delivery Date" },
  docTitle: "PURCHASE ORDER",
  saveButtons: [
    { status: "draft", label: "Save as Draft" },
    { status: "issued", label: "Save and Issue", primary: true },
  ],
};

KINDS.vendorCredit = {
  key: "vendorCredit",
  party: "vendor",
  label: "Vendor Credit",
  plural: "Vendor Credits",
  api: "/vendor-credits",
  route: "/vendor-credits",
  numberField: "number",
  numberLabel: "Vendor Credit#",
  dateLabel: "Vendor Credit Date",
  refField: "reference",
  refLabel: "Reference#",
  second: null,
  docTitle: "VENDOR CREDIT",
  saveButtons: [
    { status: "draft", label: "Save as Draft" },
    { status: "open", label: "Save as Open", primary: true },
  ],
};

export const VENDOR_CREDIT_REASONS = ["Purchase Return", "Post Purchase Discount", "Deficiency in services", "Correction in bill", "Change in POS", "Others"];

export const CREDIT_REASONS = [
  "Sales Return",
  "Post Sale Discount",
  "Deficiency in services",
  "Correction in invoice",
  "Change in POS",
  "Finalization of provisional assessment",
  "Others",
];
