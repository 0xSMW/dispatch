import { Heading, Text } from "react-email";
import { Action, If, Layout } from "./_components";
import { exampleBrand, heading, text, type Brand, type EmailVariable } from "./_theme";

const preview = "An outstanding payment still needs your attention.";

type Props = { brand?: Brand; amount: string; updatePaymentUrl: string; invoiceNumber?: string };

export default function CardUpdateReminder({ brand = exampleBrand, amount, updatePaymentUrl, invoiceNumber }: Props) {
  return (
    <Layout brand={brand} preview={preview} title="Update your payment method"
      reason="You received this email because a subscription payment is still outstanding.">
      <Heading as="h1" className="dm-text" style={heading}>Update your payment method</Heading>
      <Text className="dm-text" style={text}>
        Your {brand.productName} subscription has an outstanding balance of {amount}.
      </Text>
      <If value={invoiceNumber}><Text className="dm-text" style={text}>Invoice: {invoiceNumber}.</Text></If>
      <Text className="dm-text" style={text}>Review your payment details and update the payment method to resolve this balance.</Text>
      <Action brand={brand} href={updatePaymentUrl}>Update payment method</Action>
    </Layout>
  );
}

CardUpdateReminder.Preview = preview;
CardUpdateReminder.PreviewProps = {
  amount: "$49.00", updatePaymentUrl: "https://example.com/billing/payment", invoiceNumber: "INV-1042",
} satisfies Props;
CardUpdateReminder.Subject = "Your {{{PRODUCT_NAME}}} payment still needs attention";
CardUpdateReminder.Category = "billing";
CardUpdateReminder.Kind = "transactional" as const;
CardUpdateReminder.Stage = "dunning" as const;
CardUpdateReminder.When = "Send when a failed invoice remains unpaid after the first reminder. Stop the flow as soon as the invoice is paid.";
CardUpdateReminder.Track = true;
CardUpdateReminder.Description = "Reminds a subscriber to resolve an outstanding payment.";
CardUpdateReminder.Variables = [
  { key: "AMOUNT", prop: "amount", type: "string", fallback_value: null },
  { key: "UPDATE_PAYMENT_URL", prop: "updatePaymentUrl", type: "string", fallback_value: null },
  { key: "INVOICE_NUMBER", prop: "invoiceNumber", type: "string", fallback_value: "" },
] satisfies EmailVariable[];
