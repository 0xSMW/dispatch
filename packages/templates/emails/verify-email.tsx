import { Heading, Text } from "react-email";
import { Action, Code, If, Layout, Notice } from "./_components";
import { exampleBrand, heading, text, type Brand, type EmailVariable } from "./_theme";

const preview = "Confirm this address for your account. The link expires soon.";

type Props = {
  brand?: Brand;
  actionUrl: string;
  code?: string;
  expiresIn?: string;
};

export default function VerifyEmail({
  brand = exampleBrand,
  actionUrl,
  code,
  expiresIn = "24 hours",
}: Props) {
  return (
    <Layout
      brand={brand}
      preview={preview}
      title="Confirm your email"
      reason="You received this email because an address needed to be confirmed for your account."
    >
      <Heading as="h1" className="dm-text" style={heading}>
        Confirm your email
      </Heading>
      <Text className="dm-text" style={text}>
        Use the button below to confirm this email address for your {brand.productName} account.
      </Text>
      <Action brand={brand} href={actionUrl}>
        Confirm email
      </Action>
      <Text className="dm-text" style={text}>
        This link expires in {expiresIn}.
      </Text>
      <If value={code}>
        <Text className="dm-text" style={text}>
          If the page asks for a code, enter this one. It is not a link.
        </Text>
        <Code>{code}</Code>
      </If>
      <Notice>If you did not create an account, you can ignore this email.</Notice>
    </Layout>
  );
}

VerifyEmail.Preview = preview;
VerifyEmail.PreviewProps = {
  actionUrl: "https://example.com/verify/abc123",
  code: "482913",
  expiresIn: "24 hours",
} satisfies Props;
VerifyEmail.Subject = "Confirm your email for {{{PRODUCT_NAME}}}";
VerifyEmail.Category = "authentication";
VerifyEmail.Track = false;
VerifyEmail.Description = "Sent when someone needs to confirm an email address.";
VerifyEmail.Variables = [
  { key: "ACTION_URL", prop: "actionUrl", type: "string", fallback_value: null },
  { key: "CODE", prop: "code", type: "string", fallback_value: "" },
  { key: "EXPIRES_IN", prop: "expiresIn", type: "string", fallback_value: "24 hours" },
] satisfies EmailVariable[];
