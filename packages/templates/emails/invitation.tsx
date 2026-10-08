import { Heading, Text } from "react-email";
import { Action, If, Layout, Notice } from "./_components";
import { exampleBrand, heading, text, type Brand, type EmailVariable } from "./_theme";

const preview = "A team invitation is waiting for your response.";

type Props = {
  brand?: Brand;
  actionUrl: string;
  inviterName?: string;
  orgName?: string;
  role?: string;
  message?: string;
  expiresIn?: string;
};

export default function Invitation({
  brand = exampleBrand,
  actionUrl,
  inviterName = "A teammate",
  orgName,
  role,
  message,
  expiresIn = "7 days",
}: Props) {
  return (
    <Layout
      brand={brand}
      preview={preview}
      title="You are invited"
      reason="You received this email because someone invited you to a team."
    >
      <Heading as="h1" className="dm-text" style={heading}>
        You are invited
      </Heading>
      <Text className="dm-text" style={text}>
        {inviterName} invited you to join <If value={orgName}>{orgName} on </If>
        {brand.productName}.
      </Text>
      <If value={role}>
        <Text className="dm-text" style={text}>
          Invited role: {role}.
        </Text>
      </If>
      <If value={message}>
        <Text className="dm-text" style={text}>
          A message from {inviterName}: "{message}"
        </Text>
      </If>
      <Action brand={brand} href={actionUrl}>
        Accept invitation
      </Action>
      <Text className="dm-text" style={text}>
        This invitation expires in {expiresIn}.
      </Text>
      <Notice>If you were not expecting an invitation, you can ignore this email.</Notice>
    </Layout>
  );
}

Invitation.Preview = preview;
Invitation.PreviewProps = {
  actionUrl: "https://example.com/invite/abc123",
  inviterName: "Ada Lovelace",
  orgName: "North team",
  role: "Editor",
  message: "Come work on the launch notes with us.",
  expiresIn: "7 days",
} satisfies Props;
// With no organization name, the product name takes its place.
Invitation.Subject =
  "{{{INVITER_NAME}}} invited you to {{{#if ORG_NAME}}}{{{ORG_NAME}}}{{{/if}}}{{{#unless ORG_NAME}}}{{{PRODUCT_NAME}}}{{{/unless}}}";
Invitation.Category = "authentication";
Invitation.Kind = "transactional" as const;
Invitation.Stage = "onboarding" as const;
Invitation.When = "Send when someone invites a teammate to join. Supply the invitation link and any team details.";
Invitation.Track = false;
Invitation.Description = "Sent when a person invites someone else to a team.";
Invitation.Variables = [
  { key: "ACTION_URL", prop: "actionUrl", type: "string", fallback_value: null },
  { key: "INVITER_NAME", prop: "inviterName", type: "string", fallback_value: "A teammate" },
  { key: "ORG_NAME", prop: "orgName", type: "string", fallback_value: "" },
  { key: "ROLE", prop: "role", type: "string", fallback_value: "" },
  { key: "MESSAGE", prop: "message", type: "string", fallback_value: "" },
  { key: "EXPIRES_IN", prop: "expiresIn", type: "string", fallback_value: "7 days" },
] satisfies EmailVariable[];
