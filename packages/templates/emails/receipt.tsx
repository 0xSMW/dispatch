import { Heading, Text } from "react-email";
import { Details, If, Layout, LineItems, TextLink, type LineItem } from "./_components";
import { exampleBrand, heading, text, type Brand, type EmailVariable } from "./_theme";

const preview = "Your payment was received. This receipt lists the items, tax, and total.";

type Props = {
  brand?: Brand;
  receiptNumber: string;
  paidAt: string;
  total: string;
  lineItems: LineItem[];
  subtotal?: string;
  discount?: string;
  tax?: string;
  taxId?: string;
  cardBrand?: string;
  cardLast4?: string;
  billingAddress?: string;
  receiptUrl?: string;
};

export default function Receipt({
  brand = exampleBrand,
  receiptNumber,
  paidAt,
  total,
  lineItems,
  subtotal,
  discount,
  tax,
  taxId,
  cardBrand = "Card",
  cardLast4,
  billingAddress,
  receiptUrl,
}: Props) {
  return (
    <Layout
      brand={brand}
      preview={preview}
      title="Receipt"
      reason="You received this email because a payment was made."
    >
      <Heading as="h1" className="dm-text" style={heading}>
        Receipt
      </Heading>
      <Text className="dm-text" style={text}>
        We received your payment for {brand.productName}. This email is the receipt.
      </Text>
      <Details
        rows={[
          { label: "Receipt", value: receiptNumber },
          { label: "Paid at", value: paidAt },
        ]}
      />
      <LineItems items={lineItems} />
      <If value={subtotal}>
        <Text className="dm-text" style={text}>
          Subtotal {subtotal}
        </Text>
      </If>
      <If value={discount}>
        <Text className="dm-text" style={text}>
          Discount {discount}
        </Text>
      </If>
      <If value={tax}>
        <Text className="dm-text" style={text}>
          Tax {tax}
        </Text>
      </If>
      <If value={taxId}>
        <Text className="dm-text" style={text}>
          Tax id {taxId}
        </Text>
      </If>
      <Text className="dm-text" style={text}>
        Total {total}
      </Text>
      <If value={cardLast4}>
        <Text className="dm-text" style={text}>
          Paid with {cardBrand} ending in {cardLast4}.
        </Text>
      </If>
      <If value={billingAddress}>
        <Text className="dm-text" style={text}>
          Billing address {billingAddress}
        </Text>
      </If>
      <If value={receiptUrl}>
        <TextLink brand={brand} href={receiptUrl}>
          View receipt
        </TextLink>
      </If>
    </Layout>
  );
}

Receipt.Preview = preview;
Receipt.PreviewProps = {
  receiptNumber: "1042",
  paidAt: "March 2, 2026, 3:04 PM UTC",
  total: "$49.00",
  lineItems: [
    { description: "Field notebook", quantity: "1", amount: "$28.00" },
    { description: "Ink", quantity: "2", amount: "$21.00" },
  ],
  subtotal: "$49.00",
  discount: "$0.00",
  tax: "$0.00",
  taxId: "12-3456789",
  cardBrand: "Card",
  cardLast4: "4242",
  billingAddress: "123 Example Street, Springfield",
  receiptUrl: "https://example.com/receipts/1042",
} satisfies Props;
Receipt.Subject = "Your {{{PRODUCT_NAME}}} receipt {{{RECEIPT_NUMBER}}}";
Receipt.Category = "billing";
Receipt.Kind = "transactional" as const;
Receipt.Stage = null;
Receipt.When = "Send after a payment is captured. Include the items, total, and payment details.";
Receipt.Track = true;
Receipt.Description = "Sent when a payment is captured, with the items and the total.";
Receipt.Variables = [
  { key: "RECEIPT_NUMBER", prop: "receiptNumber", type: "string", fallback_value: null },
  { key: "PAID_AT", prop: "paidAt", type: "string", fallback_value: null },
  { key: "TOTAL", prop: "total", type: "string", fallback_value: null },
  {
    key: "LINE_ITEMS",
    prop: "lineItems",
    type: "list",
    fallback_value: null,
    fields: ["description", "quantity", "amount"],
  },
  { key: "SUBTOTAL", prop: "subtotal", type: "string", fallback_value: "" },
  { key: "DISCOUNT", prop: "discount", type: "string", fallback_value: "" },
  { key: "TAX", prop: "tax", type: "string", fallback_value: "" },
  { key: "TAX_ID", prop: "taxId", type: "string", fallback_value: "" },
  { key: "CARD_LAST4", prop: "cardLast4", type: "string", fallback_value: "" },
  { key: "BILLING_ADDRESS", prop: "billingAddress", type: "string", fallback_value: "" },
  { key: "RECEIPT_URL", prop: "receiptUrl", type: "string", fallback_value: "" },
  { key: "CARD_BRAND", prop: "cardBrand", type: "string", fallback_value: "Card" },
] satisfies EmailVariable[];
