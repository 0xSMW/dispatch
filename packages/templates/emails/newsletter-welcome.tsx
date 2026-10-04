import { Heading, Text } from "react-email";
import { Layout } from "./_components";
import { ProductAction } from "./_components/ProductAction";
import { exampleBrand, heading, text, type Brand, type EmailVariable } from "./_theme";

const preview = "You are subscribed. Here is what to expect from our product notes.";

type Props = {
  brand?: Brand;
  firstName?: string;
  actionUrl?: string;
};

export default function NewsletterWelcome({ brand = exampleBrand, firstName = "there", actionUrl }: Props) {
  return (
    <Layout brand={brand} preview={preview} title="Thanks for subscribing"
      reason="You received this email because you subscribed to our product notes." marketing>
      <Heading as="h1" className="dm-text" style={heading}>Thanks for subscribing</Heading>
      <Text className="dm-text" style={text}>
        Hi {firstName}, welcome to the {brand.productName} newsletter.
      </Text>
      <Text className="dm-text" style={text}>
        We will share product news and practical tips. You can change your preferences or unsubscribe below.
      </Text>
      <ProductAction brand={brand} href={actionUrl}>Explore {brand.productName}</ProductAction>
    </Layout>
  );
}

NewsletterWelcome.Preview = preview;
NewsletterWelcome.PreviewProps = { firstName: "Ada", actionUrl: "https://example.com/start" } satisfies Props;
NewsletterWelcome.Subject = "Welcome to the {{{PRODUCT_NAME}}} newsletter";
NewsletterWelcome.Category = "marketing";
NewsletterWelcome.Kind = "marketing" as const;
NewsletterWelcome.Stage = "acquisition" as const;
NewsletterWelcome.When = "Send after a contact subscribes to your newsletter topic. Introduce the notes they signed up to receive.";
NewsletterWelcome.Track = true;
NewsletterWelcome.Description = "Welcomes a new newsletter subscriber and explains what to expect.";
NewsletterWelcome.Variables = [
  { key: "FIRST_NAME", prop: "firstName", type: "string", fallback_value: "there" },
  { key: "ACTION_URL", prop: "actionUrl", type: "string", fallback_value: "" },
] satisfies EmailVariable[];
