import { Heading, Text } from "react-email";
import { Action, Details, If, Layout, Notice } from "./_components";
import { exampleBrand, heading, text, type Brand, type EmailVariable } from "./_theme";

const preview = "A new sign-in was recorded on your account. Revoke it if it was not you.";

type Props = {
  brand?: Brand;
  signedInAt: string;
  revokeUrl: string;
  device?: string;
  browser?: string;
  os?: string;
  ip?: string;
  location?: string;
};

export default function NewSignIn({
  brand = exampleBrand,
  signedInAt,
  revokeUrl,
  device,
  browser,
  os,
  ip,
  location,
}: Props) {
  return (
    <Layout
      brand={brand}
      preview={preview}
      title="New sign-in"
      reason="You received this email because your account was used to sign in."
    >
      <Heading as="h1" className="dm-text" style={heading}>
        New sign-in
      </Heading>
      <Text className="dm-text" style={text}>
        A new sign-in to your {brand.productName} account was recorded at {signedInAt}.
      </Text>
      <If value={device}>
        <Details rows={[{ label: "Device", value: device }]} />
      </If>
      <If value={browser}>
        <Details rows={[{ label: "Browser", value: browser }]} />
      </If>
      <If value={os}>
        <Details rows={[{ label: "Operating system", value: os }]} />
      </If>
      <If value={ip}>
        <Details rows={[{ label: "IP address", value: ip }]} />
      </If>
      <If value={location}>
        <Details rows={[{ label: "Location", value: location }]} />
      </If>
      <Action brand={brand} href={revokeUrl}>
        Revoke this sign-in
      </Action>
      <Notice>If this was you, no action is needed.</Notice>
    </Layout>
  );
}

NewSignIn.Preview = preview;
NewSignIn.PreviewProps = {
  signedInAt: "March 2, 2026, 3:04 PM UTC",
  revokeUrl: "https://example.com/account/sessions/revoke",
  device: "Mac",
  browser: "Chrome",
  os: "macOS",
  ip: "203.0.113.20",
  location: "Portland, Oregon",
} satisfies Props;
NewSignIn.Subject = "New sign-in to your {{{PRODUCT_NAME}}} account";
NewSignIn.Category = "authentication";
NewSignIn.Track = false;
NewSignIn.Description = "Sent when an account is signed in from a new session.";
NewSignIn.Variables = [
  { key: "SIGNED_IN_AT", prop: "signedInAt", type: "string", fallback_value: null },
  { key: "REVOKE_URL", prop: "revokeUrl", type: "string", fallback_value: null },
  { key: "DEVICE", prop: "device", type: "string", fallback_value: "" },
  { key: "BROWSER", prop: "browser", type: "string", fallback_value: "" },
  { key: "OS", prop: "os", type: "string", fallback_value: "" },
  { key: "IP", prop: "ip", type: "string", fallback_value: "" },
  { key: "LOCATION", prop: "location", type: "string", fallback_value: "" },
] satisfies EmailVariable[];
