export type Brand = {
  productName: string;
  productUrl: string;
  logoUrl: string;
  color: string;
  textColor: string;
  supportEmail: string;
  supportUrl: string;
  // Left out or empty, the footer has no privacy link.
  privacyUrl?: string;
  companyName: string;
  companyAddress: string;
  // The copyright year. Left out, it is the current year. The library build passes a placeholder.
  year?: string;
  // Marketing emails only. A broadcast fills the placeholder for each recipient, so it is the default.
  unsubscribeUrl?: string;
};

export type EmailVariable = {
  key: string;
  prop: string;
  type: "string" | "number" | "list";
  fallback_value?: string | number | null;
  fields?: string[];
};

export const light = {
  canvas: "#f4f4f5",
  card: "#ffffff",
  text: "#18181b",
  muted: "#3f3f46",
  button: "#18181b",
  buttonText: "#ffffff",
};

export const dark = {
  canvas: "#09090b",
  card: "#18181b",
  text: "#fafafa",
  muted: "#e4e4e7",
  // Links take the brand color in light mode. On the dark card that color can vanish (the default
  // brand color is the card color), so dark mode uses one fixed link color.
  link: "#93c5fd",
};

export const fontFamily =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

export const text = {
  fontFamily,
  fontSize: "16px",
  lineHeight: "1.5",
  color: light.text,
  marginTop: "0",
  marginBottom: "16px",
};

export const heading = {
  fontFamily,
  fontSize: "24px",
  lineHeight: "1.3",
  fontWeight: "600",
  color: light.text,
  marginTop: "0",
  marginBottom: "16px",
};

export const muted = {
  fontFamily,
  fontSize: "14px",
  lineHeight: "1.5",
  color: light.muted,
  marginTop: "0",
  marginBottom: "16px",
};

export function linkStyle(color: string) {
  return {
    color,
    textDecoration: "underline",
  };
}

export const exampleBrand: Brand = {
  productName: "Example",
  productUrl: "https://example.com",
  logoUrl: "",
  color: light.button,
  textColor: light.buttonText,
  supportEmail: "support@example.com",
  supportUrl: "https://example.com/support",
  privacyUrl: "https://example.com/privacy",
  companyName: "Example",
  companyAddress: "123 Example Street, Springfield",
};

export const themePairs = [
  {
    name: "text",
    light: { foreground: light.text, background: light.card },
    dark: { foreground: dark.text, background: dark.card },
  },
  {
    name: "muted",
    light: { foreground: light.muted, background: light.card },
    dark: { foreground: dark.muted, background: dark.card },
  },
  {
    name: "button",
    light: { foreground: light.buttonText, background: light.button },
    dark: { foreground: light.buttonText, background: light.button },
  },
  {
    name: "link",
    light: { foreground: light.button, background: light.card },
    dark: { foreground: dark.link, background: dark.card },
  },
];
