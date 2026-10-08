import { Heading, Text } from "react-email";
import { Action, Details, If, Layout, LineItems, TextLink, type LineItem } from "./_components";
import { exampleBrand, heading, text, type Brand, type EmailVariable } from "./_theme";

const preview = "Your invoice is ready. Review the amount and due date.";

type Props = {
  brand?: Brand;
  invoiceNumber: string;
  issuedAt: string;
  dueDate: string;
  amountDue: string;
  lineItems: LineItem[];
  payUrl: string;
  subtotal?: string;
  tax?: string;
  taxId?: string;
  billingAddress?: string;
  pdfUrl?: string;
};

export default function Invoice({
  brand = exampleBrand,
  invoiceNumber,
  issuedAt,
  dueDate,
  amountDue,
  lineItems,
  payUrl,
  subtotal,
  tax,
  taxId,
  billingAddress,
  pdfUrl,
}: Props) {
  return (
    <Layout
      brand={brand}
      preview={preview}
      title="Your invoice"
      reason="You received this email because an invoice was issued."
    >
      <Heading as="h1" className="dm-text" style={heading}>
        Your invoice
      </Heading>
      <Text className="dm-text" style={text}>
        {brand.companyName} issued invoice {invoiceNumber} for {brand.productName}.
      </Text>
      <Details
        rows={[
          { label: "Invoice", value: invoiceNumber },
          { label: "Issue date", value: issuedAt },
          { label: "Due date", value: dueDate },
          { label: "Amount due", value: amountDue },
        ]}
      />
      <LineItems items={lineItems} />
      <If value={subtotal}>
        <Details rows={[{ label: "Subtotal", value: subtotal }]} />
      </If>
      <If value={tax}>
        <Details rows={[{ label: "Tax", value: tax }]} />
      </If>
      <If value={taxId}>
        <Details rows={[{ label: "Tax ID", value: taxId }]} />
      </If>
      <If value={billingAddress}>
        <Details rows={[{ label: "Billing address", value: billingAddress }]} />
      </If>
      <Action brand={brand} href={payUrl}>
        Pay invoice
      </Action>
      <If value={pdfUrl}>
        <TextLink brand={brand} href={pdfUrl}>
          Download invoice PDF
        </TextLink>
      </If>
    </Layout>
  );
}

Invoice.Preview = preview;
Invoice.PreviewProps = {
  invoiceNumber: "INV-1042",
  issuedAt: "March 2, 2026, 3:04 PM UTC",
  dueDate: "March 16, 2026",
  amountDue: "$49.00",
  lineItems: [{ description: "Field notebook", quantity: "1", amount: "$49.00" }],
  payUrl: "https://example.com/invoices/1042/pay",
  subtotal: "$49.00",
  tax: "$0.00",
  taxId: "12-3456789",
  billingAddress: "123 Example Street, Springfield",
  pdfUrl: "https://example.com/invoices/1042.pdf",
} satisfies Props;
Invoice.Subject = "Invoice {{{INVOICE_NUMBER}}} from {{{COMPANY_NAME}}}";
Invoice.Category = "billing";
Invoice.Kind = "transactional" as const;
Invoice.Stage = null;
Invoice.When = "Send when an invoice is issued. Include the amount due, due date, and payment link.";
Invoice.Track = true;
Invoice.Description = "Sent when an invoice is issued and payment is due.";
Invoice.Variables = [
  { key: "INVOICE_NUMBER", prop: "invoiceNumber", type: "string", fallback_value: null },
  { key: "ISSUED_AT", prop: "issuedAt", type: "string", fallback_value: null },
  { key: "DUE_DATE", prop: "dueDate", type: "string", fallback_value: null },
  { key: "AMOUNT_DUE", prop: "amountDue", type: "string", fallback_value: null },
  {
    key: "LINE_ITEMS",
    prop: "lineItems",
    type: "list",
    fallback_value: null,
    fields: ["description", "quantity", "amount"],
  },
  { key: "PAY_URL", prop: "payUrl", type: "string", fallback_value: null },
  { key: "SUBTOTAL", prop: "subtotal", type: "string", fallback_value: "" },
  { key: "TAX", prop: "tax", type: "string", fallback_value: "" },
  { key: "TAX_ID", prop: "taxId", type: "string", fallback_value: "" },
  { key: "BILLING_ADDRESS", prop: "billingAddress", type: "string", fallback_value: "" },
  { key: "PDF_URL", prop: "pdfUrl", type: "string", fallback_value: "" },
] satisfies EmailVariable[];
