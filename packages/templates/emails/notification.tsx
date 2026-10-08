import { Heading, Text } from "react-email";
import { Action, If, Layout, TextLink } from "./_components";
import { exampleBrand, heading, text, type Brand, type EmailVariable } from "./_theme";

const preview = "A new account notification is ready for you to review.";

type Props = {
  brand?: Brand;
  heading: string;
  body: string;
  actionUrl?: string;
  actionLabel?: string;
  notificationsUrl?: string;
};

export default function Notification({
  brand = exampleBrand,
  heading: title,
  body,
  actionUrl,
  actionLabel = "View details",
  notificationsUrl,
}: Props) {
  return (
    <Layout
      brand={brand}
      preview={preview}
      title="Notification"
      reason="You received this email because your account has a new notification."
    >
      <Heading as="h1" className="dm-text" style={heading}>
        {title}
      </Heading>
      <Text className="dm-text" style={text}>
        {body}
      </Text>
      <If value={actionUrl}>
        <Action brand={brand} href={actionUrl}>
          {actionLabel}
        </Action>
      </If>
      <If value={notificationsUrl}>
        <TextLink brand={brand} href={notificationsUrl}>
          Notification settings
        </TextLink>
      </If>
    </Layout>
  );
}

Notification.Preview = preview;
Notification.PreviewProps = {
  heading: "Your export is ready",
  body: "Your account export is ready to download.",
  actionUrl: "https://example.com/exports/1042",
  actionLabel: "View details",
  notificationsUrl: "https://example.com/settings/notifications",
} satisfies Props;
Notification.Subject = "{{{HEADING}}}";
Notification.Category = "general";
Notification.Kind = "transactional" as const;
Notification.Stage = null;
Notification.When = "Send for a specific account notification. Set the heading and body, with an optional action link.";
Notification.Track = true;
Notification.Description = "Sent for a single account notice with one optional action.";
Notification.Variables = [
  { key: "HEADING", prop: "heading", type: "string", fallback_value: null },
  { key: "BODY", prop: "body", type: "string", fallback_value: null },
  { key: "ACTION_URL", prop: "actionUrl", type: "string", fallback_value: "" },
  { key: "ACTION_LABEL", prop: "actionLabel", type: "string", fallback_value: "View details" },
  { key: "NOTIFICATIONS_URL", prop: "notificationsUrl", type: "string", fallback_value: "" },
] satisfies EmailVariable[];
