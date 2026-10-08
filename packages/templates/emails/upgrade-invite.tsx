import { Heading, Text } from "react-email";
import { Layout } from "./_components";
import { ProductAction } from "./_components/ProductAction";
import { exampleBrand, heading, text, type Brand, type EmailVariable } from "./_theme";

const preview = "Compare the available plans for your next step.";

type Props = { brand?: Brand; firstName?: string; actionUrl?: string };

export default function UpgradeInvite({ brand = exampleBrand, firstName = "there", actionUrl }: Props) {
  return (
    <Layout brand={brand} preview={preview} title="Find the right plan"
      reason="You received this email because you subscribed to product recommendations." marketing>
      <Heading as="h1" className="dm-text" style={heading}>Find the right plan</Heading>
      <Text className="dm-text" style={text}>Hi {firstName}, need more capacity in {brand.productName}?</Text>
      <Text className="dm-text" style={text}>
        Compare the available plans and choose what fits your work. You can also keep your current plan.
      </Text>
      <ProductAction brand={brand} href={actionUrl}>Compare plans</ProductAction>
    </Layout>
  );
}

UpgradeInvite.Preview = preview;
UpgradeInvite.PreviewProps = { firstName: "Ada", actionUrl: "https://example.com/plans" } satisfies Props;
UpgradeInvite.Subject = "Need more room in {{{PRODUCT_NAME}}}?";
UpgradeInvite.Category = "marketing";
UpgradeInvite.Kind = "marketing" as const;
UpgradeInvite.Stage = "retention" as const;
UpgradeInvite.When = "Send when a free-plan contact reaches a usage limit. Check that they are still on the free plan before each reminder.";
UpgradeInvite.Track = true;
UpgradeInvite.Description = "Invites an active contact to compare plans when they need more capacity.";
UpgradeInvite.Variables = [
  { key: "FIRST_NAME", prop: "firstName", type: "string", fallback_value: "there" },
  { key: "ACTION_URL", prop: "actionUrl", type: "string", fallback_value: "" },
] satisfies EmailVariable[];
