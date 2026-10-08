import { Heading, Text } from "react-email";
import { Action, If, Layout, TextLink, Unless } from "./_components";
import { exampleBrand, heading, text, type Brand, type EmailVariable } from "./_theme";

const preview = "Your account is ready. Take your first step.";

type Props = {
  brand?: Brand;
  name?: string;
  actionUrl?: string;
  actionLabel?: string;
  helpUrl?: string;
};

export default function Welcome({
  brand = exampleBrand,
  name = "there",
  actionUrl,
  actionLabel = "Get started",
  helpUrl,
}: Props) {
  return (
    <Layout
      brand={brand}
      preview={preview}
      title="Welcome"
      reason="You received this email because an account was created for you."
    >
      <Heading as="h1" className="dm-text" style={heading}>
        Welcome
      </Heading>
      <Text className="dm-text" style={text}>
        Hi {name}, welcome to {brand.productName}. Your account is ready.
      </Text>
      <If value={actionUrl}>
        <Action brand={brand} href={actionUrl}>
          {actionLabel}
        </Action>
      </If>
      <Unless value={actionUrl}>
        <If value={brand.productUrl}>
          <Action brand={brand} href={brand.productUrl}>
            {actionLabel}
          </Action>
        </If>
      </Unless>
      <If value={helpUrl}>
        <TextLink brand={brand} href={helpUrl}>
          Help getting started
        </TextLink>
      </If>
      <Text className="dm-text" style={text}>
        If you did not expect this account, contact support to request its closure.
      </Text>
    </Layout>
  );
}

Welcome.Preview = preview;
Welcome.PreviewProps = {
  name: "Ada",
  actionUrl: "https://example.com/start",
  actionLabel: "Get started",
  helpUrl: "https://example.com/help",
} satisfies Props;
Welcome.Subject = "Welcome to {{{PRODUCT_NAME}}}";
Welcome.Category = "authentication";
Welcome.Kind = "transactional" as const;
Welcome.Stage = "onboarding" as const;
Welcome.When = "Send when a new account is ready to use. Link to the first useful step in the product.";
Welcome.Track = false;
Welcome.Description = "Sent when a new account is ready to use.";
Welcome.Variables = [
  { key: "RECIPIENT_NAME", prop: "name", type: "string", fallback_value: "there" },
  { key: "ACTION_URL", prop: "actionUrl", type: "string", fallback_value: "" },
  { key: "ACTION_LABEL", prop: "actionLabel", type: "string", fallback_value: "Get started" },
  { key: "HELP_URL", prop: "helpUrl", type: "string", fallback_value: "" },
] satisfies EmailVariable[];
