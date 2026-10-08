import { createContext, useContext } from "react";
import { themeContext, themeVariables } from "@dispatchmail/core";

export type EmailTheme = ReturnType<typeof themeContext>;
export const themePlaceholders = Object.fromEntries(
  themeVariables.map((key) => [key, `{{{${key}}}}`]),
) as EmailTheme;

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
  // CSS-ready values, including px units, or reserved placeholders from the library build.
  theme?: Partial<EmailTheme>;
};

export function emailTheme(brand?: Brand): EmailTheme {
  return { ...themeContext({ color: brand?.color }), ...brand?.theme };
}

export const ThemeContext = createContext<EmailTheme | null>(null);
export function useTheme(brand?: Brand): EmailTheme {
  const inherited = useContext(ThemeContext);
  return brand ? emailTheme(brand) : inherited ?? emailTheme();
}

export type EmailVariable = {
  key: string;
  prop: string;
  type: "string" | "number" | "list";
  fallback_value?: string | number | null;
  fields?: string[];
};

export const light = {
  canvas: "#f5f5f5",
  card: "#ffffff",
  text: "#171717",
  muted: "#404040",
  button: "#171717",
  buttonText: "#ffffff",
};

export const dark = {
  canvas: "#0a0a0a",
  card: "#171717",
  text: "#fafafa",
  muted: "#e5e5e5",
  // Links take the brand color in light mode. On the dark card that color can vanish (the default
  // brand color is the card color), so dark mode uses one fixed link color.
  link: "#93c5fd",
};

export const fontFamily =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

export const text = {
  // Recipes cannot read context before Layout renders. Inherit its tokenized body styles
  // instead of leaving unresolved placeholders in standalone React Email previews.
  fontFamily: "inherit",
  fontSize: "inherit",
  lineHeight: "1.5",
  color: "inherit",
  marginTop: "0",
  marginBottom: "16px",
};

export const heading = {
  fontFamily: "inherit",
  fontSize: "28px",
  lineHeight: "1.3",
  fontWeight: "600",
  color: "inherit",
  marginTop: "0",
  marginBottom: "16px",
};

export const muted = {
  fontFamily: "inherit",
  fontSize: "13px",
  lineHeight: "1.6",
  color: "inherit",
  marginTop: "0",
  marginBottom: "12px",
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
