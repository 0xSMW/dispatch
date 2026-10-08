import { Heading, Text } from "react-email";
import { Layout } from "./_components";
import { ProductAction } from "./_components/ProductAction";
import { exampleBrand, heading, text, type Brand, type EmailVariable } from "./_theme";

const preview = "Try one useful task to get started in your account.";

type Props = { brand?: Brand; firstName?: string; tip?: string; actionUrl?: string };

export default function FeatureTips({
  brand = exampleBrand, firstName = "there",
  tip = "Choose one task you do often and try it in your account. Start small, then build on what works.",
  actionUrl,
}: Props) {
  return (
    <Layout brand={brand} preview={preview} title="One tip to get started"
      reason="You received this email because you signed up for product tips." marketing>
      <Heading as="h1" className="dm-text" style={heading}>One tip to get started</Heading>
      <Text className="dm-text" style={text}>Hi {firstName}, try this in {brand.productName}:</Text>
      <Text className="dm-text" style={text}>{tip}</Text>
      <ProductAction brand={brand} href={actionUrl}>Try this tip</ProductAction>
    </Layout>
  );
}

FeatureTips.Preview = preview;
FeatureTips.PreviewProps = {
  firstName: "Ada", tip: "Save a reusable template for a message you send often.", actionUrl: "https://example.com/templates",
} satisfies Props;
FeatureTips.Subject = "A tip for your {{{PRODUCT_NAME}}} account";
FeatureTips.Category = "marketing";
FeatureTips.Kind = "marketing" as const;
FeatureTips.Stage = "onboarding" as const;
FeatureTips.When = "Send during onboarding to introduce one useful feature. Customize the tip and link for your product.";
FeatureTips.Track = true;
FeatureTips.Description = "Shares one practical product tip without overwhelming a new contact.";
FeatureTips.Variables = [
  { key: "FIRST_NAME", prop: "firstName", type: "string", fallback_value: "there" },
  { key: "TIP", prop: "tip", type: "string", fallback_value: "Choose one task you do often and try it in your account. Start small, then build on what works." },
  { key: "ACTION_URL", prop: "actionUrl", type: "string", fallback_value: "" },
] satisfies EmailVariable[];
