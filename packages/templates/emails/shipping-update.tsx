import { Heading, Text } from "react-email";
import { If, Layout, LineItems, TextLink, type LineItem } from "./_components";
import { exampleBrand, heading, text, type Brand, type EmailVariable } from "./_theme";

const listKey = Symbol.for("dispatch.list");

function LineItemBlock({ items }: { items: LineItem[] }) {
  const key = (items as unknown as Record<symbol, string | undefined>)[listKey];
  if (key) {
    return (
      <>
        {`{{{#if ${key}}}}`}
        <LineItems items={items} />
        {`{{{/if}}}`}
      </>
    );
  }
  if (items.length === 0) return null;
  return <LineItems items={items} />;
}

const preview = "Your order has a shipping update, with the carrier and tracking.";

type Props = {
  brand?: Brand;
  orderName: string;
  headline?: string;
  carrier?: string;
  trackingNumber?: string;
  trackingUrl?: string;
  estimatedDelivery?: string;
  lineItems?: LineItem[];
};

export default function ShippingUpdate({
  brand = exampleBrand,
  orderName,
  headline = "Your order is on its way",
  carrier,
  trackingNumber,
  trackingUrl,
  estimatedDelivery,
  lineItems = [],
}: Props) {
  return (
    <Layout
      brand={brand}
      preview={preview}
      title="Shipping update"
      reason="You received this email because an order you placed has a shipping update."
    >
      <Heading as="h1" className="dm-text" style={heading}>
        {headline}
      </Heading>
      <Text className="dm-text" style={text}>
        An update for order {orderName}.
      </Text>
      <If value={carrier}>
        <Text className="dm-text" style={text}>
          Carrier {carrier}.
        </Text>
      </If>
      <If value={trackingNumber}>
        <Text className="dm-text" style={text}>
          Tracking number {trackingNumber}.
        </Text>
      </If>
      <If value={estimatedDelivery}>
        <Text className="dm-text" style={text}>
          Estimated delivery {estimatedDelivery}.
        </Text>
      </If>
      <If value={trackingUrl}>
        <TextLink brand={brand} href={trackingUrl}>
          Track the shipment
        </TextLink>
      </If>
      <LineItemBlock items={lineItems} />
    </Layout>
  );
}

ShippingUpdate.Preview = preview;
ShippingUpdate.PreviewProps = {
  orderName: "1042",
  headline: "Your order is on its way",
  carrier: "Parcel Post",
  trackingNumber: "1Z999",
  trackingUrl: "https://example.com/track/1Z999",
  estimatedDelivery: "March 8, 2026",
  lineItems: [{ description: "Field notebook", quantity: "1", amount: "$28.00" }],
} satisfies Props;
ShippingUpdate.Subject = "{{{HEADLINE}}}";
ShippingUpdate.Category = "commerce";
ShippingUpdate.Track = true;
ShippingUpdate.Description = "Sent when an order's shipping status changes.";
ShippingUpdate.Variables = [
  { key: "ORDER_NAME", prop: "orderName", type: "string", fallback_value: null },
  { key: "HEADLINE", prop: "headline", type: "string", fallback_value: "Your order is on its way" },
  { key: "CARRIER", prop: "carrier", type: "string", fallback_value: "" },
  { key: "TRACKING_NUMBER", prop: "trackingNumber", type: "string", fallback_value: "" },
  { key: "TRACKING_URL", prop: "trackingUrl", type: "string", fallback_value: "" },
  { key: "ESTIMATED_DELIVERY", prop: "estimatedDelivery", type: "string", fallback_value: "" },
  {
    key: "LINE_ITEMS",
    prop: "lineItems",
    type: "list",
    fallback_value: "",
    fields: ["description", "quantity", "amount"],
  },
] satisfies EmailVariable[];
