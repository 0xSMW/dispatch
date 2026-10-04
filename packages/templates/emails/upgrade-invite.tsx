import { Heading, Text } from "react-email";
import { Layout } from "./_components";
import { ProductAction } from "./_components/ProductAction";
import { exampleBrand, heading, text, type Brand, type EmailVariable } from "./_theme";

const preview = "Need more room? Compare the plans and choose what fits your work.";

type Props = { brand?: Brand; firstName?: string; actionUrl?: string };

export default function UpgradeInvite({ brand = exampleBrand, firstName = "there", actionUrl }: Props) {
  return (
    <Layout brand={brand} preview={preview} title="Room for your next step"
      reason="You received this email because you subscribed to product recommendations." marketing>
      <Heading as="h1" className="dm-text" style={heading}>Room for your next step</Heading>
      <Text className="dm-text" style={text}>Hi {firstName}, is your current {brand.productName} plan still a good fit?</Text>
      <Text className="dm-text" style={text}>
        If you need more room, compare the available plans. Pick the one that fits your work, or stay on your current plan.
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
