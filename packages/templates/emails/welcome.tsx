import { Heading, Text } from "react-email";
import { Action, If, Layout, Unless } from "./_components";
import { exampleBrand, heading, muted, text, type Brand, type EmailVariable } from "./_theme";

const preview = "Your account is ready. Sign in when you want to get started.";

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
        Hi {name}, your {brand.productName} account is ready.
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
        <Text className="dm-muted" style={muted}>
          Help reference {helpUrl}
        </Text>
      </If>
      <Text className="dm-text" style={text}>
        If you did not expect an account, contact support and we can close it.
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
Welcome.Track = false;
Welcome.Description = "Sent when a new account is ready to use.";
Welcome.Variables = [
  { key: "RECIPIENT_NAME", prop: "name", type: "string", fallback_value: "there" },
  { key: "ACTION_URL", prop: "actionUrl", type: "string", fallback_value: "" },
  { key: "ACTION_LABEL", prop: "actionLabel", type: "string", fallback_value: "Get started" },
  { key: "HELP_URL", prop: "helpUrl", type: "string", fallback_value: "" },
] satisfies EmailVariable[];
