import { Heading, Text } from "react-email";
import { Action, If, Layout, Notice } from "./_components";
import { exampleBrand, heading, muted, text, type Brand, type EmailVariable } from "./_theme";

const preview = "Use this link to choose a new password. It expires soon.";

type Props = {
  brand?: Brand;
  actionUrl: string;
  name?: string;
  expiresIn?: string;
  browser?: string;
  os?: string;
};

export default function PasswordReset({
  brand = exampleBrand,
  actionUrl,
  name = "there",
  expiresIn = "1 hour",
  browser,
  os,
}: Props) {
  return (
    <Layout
      brand={brand}
      preview={preview}
      title="Reset your password"
      reason="You received this email because a password reset was requested for your account."
    >
      <Heading as="h1" className="dm-text" style={heading}>
        Reset your password
      </Heading>
      <Text className="dm-text" style={text}>
        Hi {name}, we received a request to reset the password for your {brand.productName} account.
      </Text>
      <Action brand={brand} href={actionUrl}>
        Reset password
      </Action>
      <Text className="dm-text" style={text}>
        This link expires in {expiresIn}. After that, ask for a new one.
      </Text>
      <If value={browser}>
        <Text className="dm-muted" style={muted}>
          The request came from {browser}.
        </Text>
      </If>
      <If value={os}>
        <Text className="dm-muted" style={muted}>
          The operating system was {os}.
        </Text>
      </If>
      <Notice>If you did not ask for this, ignore this email. Your password will not change.</Notice>
    </Layout>
  );
}

PasswordReset.Preview = preview;
PasswordReset.PreviewProps = {
  actionUrl: "https://example.com/reset/abc123",
  name: "Ada",
  expiresIn: "1 hour",
  browser: "Chrome",
  os: "macOS",
} satisfies Props;
PasswordReset.Subject = "Reset your {{{PRODUCT_NAME}}} password";
PasswordReset.Category = "authentication";
PasswordReset.Track = false;
PasswordReset.Description = "Sent when someone asks to reset the password on their account.";
PasswordReset.Variables = [
  { key: "ACTION_URL", prop: "actionUrl", type: "string", fallback_value: null },
  { key: "RECIPIENT_NAME", prop: "name", type: "string", fallback_value: "there" },
  { key: "EXPIRES_IN", prop: "expiresIn", type: "string", fallback_value: "1 hour" },
  { key: "REQUEST_BROWSER", prop: "browser", type: "string", fallback_value: "" },
  { key: "REQUEST_OS", prop: "os", type: "string", fallback_value: "" },
] satisfies EmailVariable[];
