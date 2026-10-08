import { Heading, Text } from "react-email";
import { Layout } from "./_components";
import { ProductAction } from "./_components/ProductAction";
import { exampleBrand, heading, text, type Brand, type EmailVariable } from "./_theme";

const preview = "Take a look at your options for returning to the product.";

type Props = { brand?: Brand; firstName?: string; offer?: string; actionUrl?: string };

export default function ComeBackOffer({
  brand = exampleBrand, firstName = "there",
  offer = "Take a look at the current plans and see whether one fits what you need now.", actionUrl,
}: Props) {
  return (
    <Layout brand={brand} preview={preview} title="A fresh start"
      reason="You received this email because you subscribed to product offers." marketing>
      <Heading as="h1" className="dm-text" style={heading}>A fresh start</Heading>
      <Text className="dm-text" style={text}>Hi {firstName}, would you like to give {brand.productName} another try?</Text>
      <Text className="dm-text" style={text}>{offer}</Text>
      <Text className="dm-text" style={text}>Review the details before you decide to return.</Text>
      <ProductAction brand={brand} href={actionUrl}>See your options</ProductAction>
    </Layout>
  );
}

ComeBackOffer.Preview = preview;
ComeBackOffer.PreviewProps = {
  firstName: "Ada", offer: "Explore the current plans and find one that fits your next project.", actionUrl: "https://example.com/plans",
} satisfies Props;
ComeBackOffer.Subject = "A fresh start with {{{PRODUCT_NAME}}}";
ComeBackOffer.Category = "marketing";
ComeBackOffer.Kind = "marketing" as const;
ComeBackOffer.Stage = "reactivation" as const;
ComeBackOffer.When = "Send to a contact who is still inactive or whose plan remains canceled. If you include an offer, set its terms and destination before sending.";
ComeBackOffer.Track = true;
ComeBackOffer.Description = "Invites a former or inactive contact to review their options for returning.";
ComeBackOffer.Variables = [
  { key: "FIRST_NAME", prop: "firstName", type: "string", fallback_value: "there" },
  { key: "OFFER", prop: "offer", type: "string", fallback_value: "Take a look at the current plans and see whether one fits what you need now." },
  { key: "ACTION_URL", prop: "actionUrl", type: "string", fallback_value: "" },
] satisfies EmailVariable[];
