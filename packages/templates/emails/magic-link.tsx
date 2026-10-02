import { Heading, Text } from "react-email";
import { Action, Code, If, Layout, Notice } from "./_components";
import { exampleBrand, heading, text, type Brand, type EmailVariable } from "./_theme";

const preview = "Use this link to sign in. It expires soon and works one time.";

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
        Use the button below to sign in to your {brand.productName} account.
      </Text>
      <Action brand={brand} href={actionUrl}>
        Sign in
      </Action>
      <Text className="dm-text" style={text}>
        This link expires in {expiresIn} and works one time.
      </Text>
      <If value={code}>
        <Text className="dm-text" style={text}>
          If you are asked for a code, enter this one. It is not a link.
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
MagicLink.Track = false;
MagicLink.Description = "Sent when someone asks for a link to sign in.";
MagicLink.Variables = [
  { key: "ACTION_URL", prop: "actionUrl", type: "string", fallback_value: null },
  { key: "CODE", prop: "code", type: "string", fallback_value: "" },
  { key: "EXPIRES_IN", prop: "expiresIn", type: "string", fallback_value: "1 hour" },
] satisfies EmailVariable[];
