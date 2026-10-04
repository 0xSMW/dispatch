import { Heading, Text } from "react-email";
import { Action, If, Layout } from "./_components";
import { exampleBrand, heading, text, type Brand, type EmailVariable } from "./_theme";

const preview = "Your payment still needs attention. Update your payment method.";

type Props = { brand?: Brand; amount: string; updatePaymentUrl: string; invoiceNumber?: string };

export default function CardUpdateReminder({ brand = exampleBrand, amount, updatePaymentUrl, invoiceNumber }: Props) {
  return (
    <Layout brand={brand} preview={preview} title="Update your payment method"
      reason="You received this email because a subscription payment is still outstanding.">
      <Heading as="h1" className="dm-text" style={heading}>Update your payment method</Heading>
      <Text className="dm-text" style={text}>
        We still could not collect {amount} for your {brand.productName} subscription.
      </Text>
      <If value={invoiceNumber}><Text className="dm-text" style={text}>Invoice {invoiceNumber} needs attention.</Text></If>
      <Text className="dm-text" style={text}>Review the payment details and update your payment method to resolve the balance.</Text>
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
