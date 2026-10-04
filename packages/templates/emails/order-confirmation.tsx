import { Heading, Text } from "react-email";
import { Action, If, Layout, LineItems, type LineItem } from "./_components";
import { exampleBrand, heading, text, type Brand, type EmailVariable } from "./_theme";

const preview = "We received your order. This note confirms the items and the total.";

type Props = {
  brand?: Brand;
  orderName: string;
  orderStatusUrl: string;
  lineItems: LineItem[];
  total: string;
  subtotal?: string;
  discount?: string;
  shipping?: string;
  tax?: string;
  shippingAddress?: string;
  billingAddress?: string;
  paymentMethod?: string;
};

export default function OrderConfirmation({
  brand = exampleBrand,
  orderName,
  orderStatusUrl,
  lineItems,
  total,
  subtotal,
  discount,
  shipping,
  tax,
  shippingAddress,
  billingAddress,
  paymentMethod,
}: Props) {
  return (
    <Layout
      brand={brand}
      preview={preview}
      title="Order confirmed"
      reason="You received this email because you placed an order."
    >
      <Heading as="h1" className="dm-text" style={heading}>
        Order confirmed
      </Heading>
      <Text className="dm-text" style={text}>
        We received order {orderName}. This email confirms the items and the amount paid.
      </Text>
      <LineItems items={lineItems} showImage />
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
      <If value={shipping}>
        <Text className="dm-text" style={text}>
          Shipping {shipping}
        </Text>
      </If>
      <If value={tax}>
        <Text className="dm-text" style={text}>
          Tax {tax}
        </Text>
      </If>
      <Text className="dm-text" style={text}>
        Total {total}
      </Text>
      <If value={shippingAddress}>
        <Text className="dm-text" style={text}>
          Shipping address {shippingAddress}
        </Text>
      </If>
      <If value={billingAddress}>
        <Text className="dm-text" style={text}>
          Billing address {billingAddress}
        </Text>
      </If>
      <If value={paymentMethod}>
        <Text className="dm-text" style={text}>
          Payment method {paymentMethod}
        </Text>
      </If>
      <Action brand={brand} href={orderStatusUrl}>
        View order status
      </Action>
    </Layout>
  );
}

OrderConfirmation.Preview = preview;
OrderConfirmation.PreviewProps = {
  orderName: "1042",
  orderStatusUrl: "https://example.com/orders/1042",
  lineItems: [
    {
      description: "Field notebook",
      quantity: "1",
      amount: "$28.00",
      image_url: "https://example.com/notebook.png",
    },
    { description: "Ink", quantity: "2", amount: "$21.00", image_url: "" },
  ],
  total: "$49.00",
  subtotal: "$49.00",
  discount: "$0.00",
  shipping: "$0.00",
  tax: "$0.00",
  shippingAddress: "123 Example Street, Springfield",
  billingAddress: "123 Example Street, Springfield",
  paymentMethod: "Card ending in 4242",
} satisfies Props;
OrderConfirmation.Subject = "Order {{{ORDER_NAME}}} confirmed";
OrderConfirmation.Category = "commerce";
OrderConfirmation.Kind = "transactional" as const;
OrderConfirmation.Stage = null;
OrderConfirmation.When = "Send after an order is placed. Confirm its items and total with a link to the order status.";
OrderConfirmation.Track = true;
OrderConfirmation.Description = "Sent when an order is placed, with the items and the total.";
OrderConfirmation.Variables = [
  { key: "ORDER_NAME", prop: "orderName", type: "string", fallback_value: null },
  { key: "ORDER_STATUS_URL", prop: "orderStatusUrl", type: "string", fallback_value: null },
  {
    key: "LINE_ITEMS",
    prop: "lineItems",
    type: "list",
    fallback_value: null,
    fields: ["description", "quantity", "amount", "image_url"],
  },
  { key: "TOTAL", prop: "total", type: "string", fallback_value: null },
  { key: "SUBTOTAL", prop: "subtotal", type: "string", fallback_value: "" },
  { key: "DISCOUNT", prop: "discount", type: "string", fallback_value: "" },
  { key: "SHIPPING", prop: "shipping", type: "string", fallback_value: "" },
  { key: "TAX", prop: "tax", type: "string", fallback_value: "" },
  { key: "SHIPPING_ADDRESS", prop: "shippingAddress", type: "string", fallback_value: "" },
  { key: "BILLING_ADDRESS", prop: "billingAddress", type: "string", fallback_value: "" },
  { key: "PAYMENT_METHOD", prop: "paymentMethod", type: "string", fallback_value: "" },
] satisfies EmailVariable[];
