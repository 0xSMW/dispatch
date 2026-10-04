import { Heading, Text } from "react-email";
import { Action, Layout, Notice } from "./_components";
import { exampleBrand, heading, text, type Brand, type EmailVariable } from "./_theme";

const preview = "Confirm your subscription before we send you any product notes.";

type Props = { brand?: Brand; confirmUrl: string; expiresIn?: string };

export default function ConfirmSubscription({ brand = exampleBrand, confirmUrl, expiresIn = "7 days" }: Props) {
  return (
    <Layout brand={brand} preview={preview} title="Confirm your subscription"
      reason="You received this email because this address was submitted on a signup form.">
      <Heading as="h1" className="dm-text" style={heading}>Confirm your subscription</Heading>
      <Text className="dm-text" style={text}>
        Confirm that you want to receive emails from {brand.productName}. You are not subscribed until you confirm.
      </Text>
      <Action brand={brand} href={confirmUrl}>Confirm subscription</Action>
      <Text className="dm-text" style={text}>This link expires in {expiresIn}.</Text>
      <Notice>If you did not request this subscription, ignore this email. We will not subscribe you.</Notice>
    </Layout>
  );
}

ConfirmSubscription.Preview = preview;
ConfirmSubscription.PreviewProps = { confirmUrl: "https://example.com/confirm/token", expiresIn: "7 days" } satisfies Props;
ConfirmSubscription.Subject = "Confirm your {{{PRODUCT_NAME}}} subscription";
ConfirmSubscription.Category = "authentication";
ConfirmSubscription.Kind = "transactional" as const;
ConfirmSubscription.Stage = null;
ConfirmSubscription.When = "Send after a signup form requests double opt-in. Only subscribe the contact after they confirm.";
ConfirmSubscription.Track = false;
ConfirmSubscription.Description = "Asks a signup-form contact to confirm their subscription without subscribing them yet.";
ConfirmSubscription.Variables = [
  { key: "CONFIRM_URL", prop: "confirmUrl", type: "string", fallback_value: null },
  { key: "EXPIRES_IN", prop: "expiresIn", type: "string", fallback_value: "7 days" },
] satisfies EmailVariable[];
