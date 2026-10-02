import { Heading, Text } from "react-email";
import { Action, If, Layout, Notice } from "./_components";
import { exampleBrand, heading, muted, text, type Brand, type EmailVariable } from "./_theme";

const preview = "A security change was saved on your account. Review it if it was not you.";

type Props = {
  brand?: Brand;
  change: string;
  secureAccountUrl: string;
  changedAt?: string;
  location?: string;
  device?: string;
};

export default function SecurityNotice({
  brand = exampleBrand,
  change,
  secureAccountUrl,
  changedAt,
  location,
  device,
}: Props) {
  return (
    <Layout
      brand={brand}
      preview={preview}
      title="Security change"
      reason="You received this email because a security setting on your account changed."
    >
      <Heading as="h1" className="dm-text" style={heading}>
        {change}
      </Heading>
      <Text className="dm-text" style={text}>
        This change was saved on your {brand.productName} account.
      </Text>
      <If value={changedAt}>
        <Text className="dm-muted" style={muted}>
          Changed at {changedAt}.
        </Text>
      </If>
      <If value={location}>
        <Text className="dm-muted" style={muted}>
          Location {location}.
        </Text>
      </If>
      <If value={device}>
        <Text className="dm-muted" style={muted}>
          Device {device}.
        </Text>
      </If>
      <Action brand={brand} href={secureAccountUrl}>
        Secure your account
      </Action>
      <Notice>If you made this change, no action is needed.</Notice>
    </Layout>
  );
}

SecurityNotice.Preview = preview;
SecurityNotice.PreviewProps = {
  change: "Your password was changed",
  secureAccountUrl: "https://example.com/account/security",
  changedAt: "March 2, 2026, 3:04 PM UTC",
  location: "Portland, Oregon",
  device: "Mac",
} satisfies Props;
SecurityNotice.Subject = "{{{CHANGE}}}";
SecurityNotice.Category = "authentication";
SecurityNotice.Track = false;
SecurityNotice.Description = "Sent when a security setting on an account changes.";
SecurityNotice.Variables = [
  { key: "CHANGE", prop: "change", type: "string", fallback_value: null },
  { key: "SECURE_ACCOUNT_URL", prop: "secureAccountUrl", type: "string", fallback_value: null },
  { key: "CHANGED_AT", prop: "changedAt", type: "string", fallback_value: "" },
  { key: "REQUEST_LOCATION", prop: "location", type: "string", fallback_value: "" },
  { key: "REQUEST_DEVICE", prop: "device", type: "string", fallback_value: "" },
] satisfies EmailVariable[];
