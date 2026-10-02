import { Heading, Text } from "react-email";
import { Action, If, Layout, TextLink } from "./_components";
import { exampleBrand, heading, text, type Brand, type EmailVariable } from "./_theme";

const preview = "Your trial is ending. Choose a plan if you want to keep the account.";

type Props = {
  brand?: Brand;
  trialEndDate: string;
  actionUrl: string;
  cancelUrl?: string;
  exportUrl?: string;
};

export default function TrialEnding({
  brand = exampleBrand,
  trialEndDate,
  actionUrl,
  cancelUrl,
  exportUrl,
}: Props) {
  return (
    <Layout
      brand={brand}
      preview={preview}
      title="Your trial is ending"
      reason="You received this email because your trial is close to its end."
    >
      <Heading as="h1" className="dm-text" style={heading}>
        Your trial is ending
      </Heading>
      <Text className="dm-text" style={text}>
        Your {brand.productName} trial ends on {trialEndDate}. Choose a plan if you want to keep the account.
      </Text>
      <Action brand={brand} href={actionUrl}>
        Choose a plan
      </Action>
      <If value={cancelUrl}>
        <TextLink brand={brand} href={cancelUrl}>
          Cancel before the trial ends
        </TextLink>
      </If>
      <If value={exportUrl}>
        <TextLink brand={brand} href={exportUrl}>
          Export your data
        </TextLink>
      </If>
    </Layout>
  );
}

TrialEnding.Preview = preview;
TrialEnding.PreviewProps = {
  trialEndDate: "March 16, 2026",
  actionUrl: "https://example.com/billing/plan",
  cancelUrl: "https://example.com/billing/cancel",
  exportUrl: "https://example.com/account/export",
} satisfies Props;
TrialEnding.Subject = "Your {{{PRODUCT_NAME}}} trial ends on {{{TRIAL_END_DATE}}}";
TrialEnding.Category = "billing";
TrialEnding.Track = true;
TrialEnding.Description = "Sent before a trial ends so the reader can choose a plan.";
TrialEnding.Variables = [
  { key: "TRIAL_END_DATE", prop: "trialEndDate", type: "string", fallback_value: null },
  { key: "ACTION_URL", prop: "actionUrl", type: "string", fallback_value: null },
  { key: "CANCEL_URL", prop: "cancelUrl", type: "string", fallback_value: "" },
  { key: "EXPORT_URL", prop: "exportUrl", type: "string", fallback_value: "" },
] satisfies EmailVariable[];
