import { Heading, Text } from "react-email";
import { Action, If, Layout } from "./_components";
import { exampleBrand, heading, text, type Brand, type EmailVariable } from "./_theme";

const preview = "Your subscription was canceled after an unpaid invoice.";

type Props = { brand?: Brand; updatePaymentUrl: string; invoiceNumber?: string };

export default function SubscriptionCanceled({ brand = exampleBrand, updatePaymentUrl, invoiceNumber }: Props) {
  return (
    <Layout brand={brand} preview={preview} title="Your subscription was canceled"
      reason="You received this email because your subscription was canceled after an unpaid invoice.">
      <Heading as="h1" className="dm-text" style={heading}>Your subscription was canceled</Heading>
      <Text className="dm-text" style={text}>Your {brand.productName} subscription was canceled because payment was not completed.</Text>
      <If value={invoiceNumber}><Text className="dm-text" style={text}>Outstanding invoice: {invoiceNumber}.</Text></If>
      <Text className="dm-text" style={text}>
        Review billing to resolve the outstanding payment. Contact support if you need help with your account.
      </Text>
      <Action brand={brand} href={updatePaymentUrl}>Review billing</Action>
    </Layout>
  );
}

SubscriptionCanceled.Preview = preview;
SubscriptionCanceled.PreviewProps = {
  updatePaymentUrl: "https://example.com/billing/payment", invoiceNumber: "INV-1042",
} satisfies Props;
SubscriptionCanceled.Subject = "Your {{{PRODUCT_NAME}}} subscription was canceled";
SubscriptionCanceled.Category = "billing";
SubscriptionCanceled.Kind = "transactional" as const;
SubscriptionCanceled.Stage = "dunning" as const;
SubscriptionCanceled.When = "Send after your billing system cancels a subscription for nonpayment. This email does not cancel the subscription itself.";
SubscriptionCanceled.Track = true;
SubscriptionCanceled.Description = "Explains a nonpayment cancellation and links to billing.";
SubscriptionCanceled.Variables = [
  { key: "UPDATE_PAYMENT_URL", prop: "updatePaymentUrl", type: "string", fallback_value: null },
  { key: "INVOICE_NUMBER", prop: "invoiceNumber", type: "string", fallback_value: "" },
] satisfies EmailVariable[];
