import { Heading, Text } from "react-email";
import { Layout } from "./_components";
import { ProductAction } from "./_components/ProductAction";
import { exampleBrand, heading, text, type Brand, type EmailVariable } from "./_theme";

const preview = "Pick up where you left off and continue your account setup.";

type Props = { brand?: Brand; firstName?: string; actionUrl?: string };

export default function SetupReminder({ brand = exampleBrand, firstName = "there", actionUrl }: Props) {
  return (
    <Layout brand={brand} preview={preview} title="Continue your setup"
      reason="You received this email because you signed up for tips on getting started." marketing>
      <Heading as="h1" className="dm-text" style={heading}>Continue your setup</Heading>
      <Text className="dm-text" style={text}>
        Hi {firstName}, ready to continue setting up {brand.productName}?
      </Text>
      <Text className="dm-text" style={text}>
        Pick up where you left off. If you need a hand, contact support.
      </Text>
      <ProductAction brand={brand} href={actionUrl}>Continue setup</ProductAction>
    </Layout>
  );
}

SetupReminder.Preview = preview;
SetupReminder.PreviewProps = { firstName: "Ada", actionUrl: "https://example.com/setup" } satisfies Props;
SetupReminder.Subject = "Take the next step with {{{PRODUCT_NAME}}}";
SetupReminder.Category = "marketing";
SetupReminder.Kind = "marketing" as const;
SetupReminder.Stage = "onboarding" as const;
SetupReminder.When = "Send a few days after signup to contacts who have not activated. Stop the onboarding flow when they activate.";
SetupReminder.Track = true;
SetupReminder.Description = "Encourages a new contact to finish setup, with a link back to the product.";
SetupReminder.Variables = [
  { key: "FIRST_NAME", prop: "firstName", type: "string", fallback_value: "there" },
  { key: "ACTION_URL", prop: "actionUrl", type: "string", fallback_value: "" },
] satisfies EmailVariable[];
