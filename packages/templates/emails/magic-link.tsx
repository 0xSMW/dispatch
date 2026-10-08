import { Heading, Text } from "react-email";
import { Action, Code, If, Layout, Notice } from "./_components";
import { exampleBrand, heading, text, type Brand, type EmailVariable } from "./_theme";

const preview = "Your one-time sign-in link is ready to use.";

type Props = {
  brand?: Brand;
  actionUrl: string;
  code?: string;
  expiresIn?: string;
};

export default function MagicLink({
  brand = exampleBrand,
  actionUrl,
  code,
  expiresIn = "1 hour",
}: Props) {
  return (
    <Layout
      brand={brand}
      preview={preview}
      title="Sign in"
      reason="You received this email because a sign-in link was requested for your account."
    >
      <Heading as="h1" className="dm-text" style={heading}>
        Sign in
      </Heading>
      <Text className="dm-text" style={text}>
        Sign in to your {brand.productName} account with this one-time link.
      </Text>
      <Action brand={brand} href={actionUrl}>
        Sign in
      </Action>
      <Text className="dm-text" style={text}>
        This link expires in {expiresIn} and can be used once.
      </Text>
      <If value={code}>
        <Text className="dm-text" style={text}>
          If the page asks for a sign-in code, enter:
        </Text>
        <Code>{code}</Code>
      </If>
      <Notice>If you did not try to sign in, you can ignore this email.</Notice>
    </Layout>
  );
}

MagicLink.Preview = preview;
MagicLink.PreviewProps = {
  actionUrl: "https://example.com/sign-in/abc123",
  code: "482913",
  expiresIn: "1 hour",
} satisfies Props;
MagicLink.Subject = "Your {{{PRODUCT_NAME}}} sign-in link";
MagicLink.Category = "authentication";
MagicLink.Kind = "transactional" as const;
MagicLink.Stage = null;
MagicLink.When = "Send when a person requests a sign-in link. Use a short-lived link that works once.";
MagicLink.Track = false;
MagicLink.Description = "Sent when someone asks for a link to sign in.";
MagicLink.Variables = [
  { key: "ACTION_URL", prop: "actionUrl", type: "string", fallback_value: null },
  { key: "CODE", prop: "code", type: "string", fallback_value: "" },
  { key: "EXPIRES_IN", prop: "expiresIn", type: "string", fallback_value: "1 hour" },
] satisfies EmailVariable[];
