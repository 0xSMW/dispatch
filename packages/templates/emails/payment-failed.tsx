import { Heading, Text } from "react-email";
import { Action, If, Layout, TextLink } from "./_components";
import { exampleBrand, heading, text, type Brand, type EmailVariable } from "./_theme";

const preview = "Your payment needs attention. Review your payment method.";

type Props = {
  brand?: Brand;
  amount: string;
  updatePaymentUrl: string;
  cardBrand?: string;
  cardLast4?: string;
  nextRetryAt?: string;
  serviceEndsAt?: string;
  invoiceUrl?: string;
};

export default function PaymentFailed({
  brand = exampleBrand,
  amount,
  updatePaymentUrl,
  cardBrand = "card",
  cardLast4,
  nextRetryAt,
  serviceEndsAt,
  invoiceUrl,
}: Props) {
  return (
    <Layout
      brand={brand}
      preview={preview}
      title="Your payment needs attention"
      reason="You received this email because a payment failed."
    >
      <Heading as="h1" className="dm-text" style={heading}>
        Your payment needs attention
      </Heading>
      <Text className="dm-text" style={text}>
        We could not collect {amount} for your {brand.productName} subscription.
      </Text>
      <If value={cardLast4}>
        <Text className="dm-text" style={text}>
          Payment method: {cardBrand} ending in {cardLast4}.
        </Text>
      </If>
      <If value={nextRetryAt}>
        <Text className="dm-text" style={text}>
          We will try again on {nextRetryAt}.
        </Text>
      </If>
      <If value={serviceEndsAt}>
        <Text className="dm-text" style={text}>
          Service ends on {serviceEndsAt} if the payment is not updated.
        </Text>
      </If>
      <Action brand={brand} href={updatePaymentUrl}>
        Update payment method
      </Action>
      <If value={invoiceUrl}>
        <TextLink brand={brand} href={invoiceUrl}>
          View invoice
        </TextLink>
      </If>
    </Layout>
  );
}

PaymentFailed.Preview = preview;
PaymentFailed.PreviewProps = {
  amount: "$49.00",
  updatePaymentUrl: "https://example.com/billing/payment",
  cardBrand: "card",
  cardLast4: "4242",
  nextRetryAt: "March 4, 2026, 9:00 AM UTC",
  serviceEndsAt: "March 9, 2026",
  invoiceUrl: "https://example.com/invoices/1042",
} satisfies Props;
PaymentFailed.Subject = "Your {{{PRODUCT_NAME}}} payment failed";
PaymentFailed.Category = "billing";
PaymentFailed.Kind = "transactional" as const;
PaymentFailed.Stage = "dunning" as const;
PaymentFailed.When = "Send after an invoice payment fails. Supply AMOUNT and UPDATE_PAYMENT_URL from the payment event.";
PaymentFailed.Track = true;
PaymentFailed.Description = "Sent when a payment attempt does not go through.";
PaymentFailed.Variables = [
  { key: "AMOUNT", prop: "amount", type: "string", fallback_value: null },
  { key: "UPDATE_PAYMENT_URL", prop: "updatePaymentUrl", type: "string", fallback_value: null },
  { key: "CARD_BRAND", prop: "cardBrand", type: "string", fallback_value: "card" },
  { key: "CARD_LAST4", prop: "cardLast4", type: "string", fallback_value: "" },
  { key: "NEXT_RETRY_AT", prop: "nextRetryAt", type: "string", fallback_value: "" },
  { key: "SERVICE_ENDS_AT", prop: "serviceEndsAt", type: "string", fallback_value: "" },
  { key: "INVOICE_URL", prop: "invoiceUrl", type: "string", fallback_value: "" },
] satisfies EmailVariable[];
