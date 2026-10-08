import { Heading, Text } from "react-email";
import { Code, If, Layout, Notice } from "./_components";
import { exampleBrand, heading, muted, text, type Brand, type EmailVariable } from "./_theme";

const preview = (code: string) => `${code} is your sign-in code. Do not share it.`;

type Props = {
  brand?: Brand;
  code: string;
  expiresIn?: string;
  location?: string;
  device?: string;
};

export default function OneTimeCode({
  brand = exampleBrand,
  code,
  expiresIn = "10 minutes",
  location,
  device,
}: Props) {
  return (
    <Layout
      brand={brand}
      preview={preview(code)}
      title="Your sign-in code"
      reason="You received this email because a sign-in code was requested for your account."
    >
      <Heading as="h1" className="dm-text" style={heading}>
        Your sign-in code
      </Heading>
      <Text className="dm-text" style={text}>
        Enter this code to sign in to {brand.productName}. Do not share it.
      </Text>
      <Code>{code}</Code>
      <Text className="dm-text" style={text}>
        This code expires in {expiresIn}.
      </Text>
      <If value={location}>
        <Text className="dm-muted" style={muted}>
          Request location: {location}.
        </Text>
      </If>
      <If value={device}>
        <Text className="dm-muted" style={muted}>
          Device: {device}.
        </Text>
      </If>
      <Notice>If you did not try to sign in, you can ignore this email.</Notice>
    </Layout>
  );
}

OneTimeCode.Preview = preview("{{{CODE}}}");
OneTimeCode.PreviewProps = {
  code: "482913",
  expiresIn: "10 minutes",
  location: "Portland, Oregon",
  device: "iPhone",
} satisfies Props;
OneTimeCode.Subject = "{{{CODE}}} is your {{{PRODUCT_NAME}}} code";
OneTimeCode.Category = "authentication";
OneTimeCode.Kind = "transactional" as const;
OneTimeCode.Stage = null;
OneTimeCode.When = "Send when a person requests a one-time sign-in code. Supply the code and its expiry.";
OneTimeCode.Track = false;
OneTimeCode.Description = "Sent when someone needs a one-time code to sign in.";
OneTimeCode.Variables = [
  { key: "CODE", prop: "code", type: "string", fallback_value: null },
  { key: "EXPIRES_IN", prop: "expiresIn", type: "string", fallback_value: "10 minutes" },
  { key: "REQUEST_LOCATION", prop: "location", type: "string", fallback_value: "" },
  { key: "REQUEST_DEVICE", prop: "device", type: "string", fallback_value: "" },
] satisfies EmailVariable[];
