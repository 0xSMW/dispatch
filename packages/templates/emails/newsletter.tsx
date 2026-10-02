import { Heading, Text } from "react-email";
import { Each, If, Layout, TextLink } from "./_components";
import { exampleBrand, heading, text, type Brand, type EmailVariable } from "./_theme";

const preview = "Short notes from the product, with sections you can read or skip.";

type SectionItem = {
  title: string;
  text: string;
  url: string;
  link_label: string;
};

type Props = {
  brand?: Brand;
  sections: SectionItem[];
  intro?: string;
  webVersionUrl?: string;
};

export default function Newsletter({
  brand = exampleBrand,
  sections,
  intro,
  webVersionUrl,
}: Props) {
  return (
    <Layout
      brand={brand}
      preview={preview}
      title="Latest notes"
      reason="You received this email because you subscribed to notes from the product."
      marketing
    >
      <Heading as="h1" className="dm-text" style={heading}>
        Latest from {brand.productName}
      </Heading>
      <If value={intro}>
        <Text className="dm-text" style={text}>
          {intro}
        </Text>
      </If>
      <Each items={sections}>
        {(section) => (
          <>
            <Text className="dm-text" style={{ ...text, fontWeight: "600" }}>
              {section.title}
            </Text>
            <Text className="dm-text" style={text}>
              {section.text}
            </Text>
            <TextLink brand={brand} href={section.url}>
              {section.link_label}
            </TextLink>
          </>
        )}
      </Each>
      <If value={webVersionUrl}>
        <TextLink brand={brand} href={webVersionUrl}>
          View this email in a browser
        </TextLink>
      </If>
    </Layout>
  );
}

Newsletter.Preview = preview;
Newsletter.PreviewProps = {
  intro: "Three short notes from the last month.",
  webVersionUrl: "https://example.com/newsletters/march",
  sections: [
    {
      title: "A quieter editor",
      text: "The editor now keeps the toolbar out of the way until you ask for it.",
      url: "https://example.com/notes/editor",
      link_label: "Read about the editor",
    },
    {
      title: "Exports",
      text: "Account exports now include the attachments as well as the text.",
      url: "https://example.com/notes/exports",
      link_label: "Read about exports",
    },
  ],
} satisfies Props;
// The subject of a newsletter is set on the send or the broadcast. This one is the default when none is given.
Newsletter.Subject = "Latest from {{{PRODUCT_NAME}}}";
Newsletter.Category = "marketing";
Newsletter.Track = true;
Newsletter.Description = "Sent as a marketing note with sections, an address, and an unsubscribe link.";
Newsletter.Variables = [
  {
    key: "SECTIONS",
    prop: "sections",
    type: "list",
    fallback_value: null,
    fields: ["title", "text", "url", "link_label"],
  },
  { key: "INTRO", prop: "intro", type: "string", fallback_value: "" },
  { key: "WEB_VERSION_URL", prop: "webVersionUrl", type: "string", fallback_value: "" },
] satisfies EmailVariable[];
