import { Heading, Text } from "react-email";

type Props = {
  name?: string;
  actionUrl?: string;
};

// Named hello, not welcome: `templates push` takes the alias from the file name, and `welcome`
// is one of the library templates every tenant starts with.
export default function Hello({ name = "there", actionUrl = "https://example.com" }: Props) {
  return (
    <html lang="en" dir="ltr">
      <body>
        <Heading as="h1">Welcome, {name}</Heading>
        <Text>Open {actionUrl} when you are ready to get started.</Text>
      </body>
    </html>
  );
}

Hello.PreviewProps = {
  name: "Ada",
  actionUrl: "https://example.com/start",
} satisfies Props;

Hello.Subject = "Welcome, {{{RECIPIENT_NAME}}}";

Hello.Variables = [
  { key: "RECIPIENT_NAME", prop: "name", type: "string" as const, fallback_value: "there" },
  { key: "ACTION_URL", prop: "actionUrl", type: "string" as const, fallback_value: "https://example.com" },
];
