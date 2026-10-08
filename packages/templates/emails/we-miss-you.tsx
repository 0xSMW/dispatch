import { Heading, Text } from "react-email";
import { Layout } from "./_components";
import { ProductAction } from "./_components/ProductAction";
import { exampleBrand, heading, text, type Brand, type EmailVariable } from "./_theme";

const preview = "Pick up where you left off when you are ready.";

type Props = { brand?: Brand; firstName?: string; actionUrl?: string };

export default function WeMissYou({ brand = exampleBrand, firstName = "there", actionUrl }: Props) {
  return (
    <Layout brand={brand} preview={preview} title="Ready to pick things up?"
      reason="You received this email because you subscribed to product reminders." marketing>
      <Heading as="h1" className="dm-text" style={heading}>Ready to pick things up?</Heading>
      <Text className="dm-text" style={text}>Hi {firstName}, it has been a while since you used {brand.productName}.</Text>
      <Text className="dm-text" style={text}>
        Open your account when you are ready to continue. Contact support if you need help getting back into it.
      </Text>
      <ProductAction brand={brand} href={actionUrl}>Return to {brand.productName}</ProductAction>
    </Layout>
  );
}

WeMissYou.Preview = preview;
WeMissYou.PreviewProps = { firstName: "Ada", actionUrl: "https://example.com/account" } satisfies Props;
WeMissYou.Subject = "Pick things up in {{{PRODUCT_NAME}}}";
WeMissYou.Category = "marketing";
WeMissYou.Kind = "marketing" as const;
WeMissYou.Stage = "reengagement" as const;
WeMissYou.When = "Send after your app reports that a contact is inactive. Keep last_active_at current so later reminders stop when they return.";
WeMissYou.Track = true;
WeMissYou.Description = "Gives an inactive contact a simple path back to the product.";
WeMissYou.Variables = [
  { key: "FIRST_NAME", prop: "firstName", type: "string", fallback_value: "there" },
  { key: "ACTION_URL", prop: "actionUrl", type: "string", fallback_value: "" },
] satisfies EmailVariable[];
