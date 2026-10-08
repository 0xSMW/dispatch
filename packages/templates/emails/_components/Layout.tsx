import type React from "react";
import { Body, Head, Html, Img, Link, Preview, Section, Text } from "react-email";
import { dark, emailTheme, exampleBrand, light, linkStyle, muted, text, ThemeContext, type Brand } from "../_theme";
import { If, Unless } from "./If";

const darkModeCss = `
  .dm-canvas { background-color: ${light.canvas}; }
  .dm-card { background-color: ${light.card}; }
  @media (prefers-color-scheme: dark) {
    .dm-canvas, .dm-canvas > table > tbody > tr > td { background-color: ${dark.canvas} !important; }
    .dm-card { background-color: ${dark.card} !important; }
    .dm-text { color: ${dark.text} !important; }
    .dm-divider { border-color: #404040 !important; }
    .dm-button { background-color: #fafafa !important; color: #171717 !important; border-color: #fafafa !important; }
    .dm-muted { color: ${dark.muted} !important; }
    a.dm-link { color: ${dark.link} !important; }
  }
`;

function Header({ brand }: { brand: Brand }) {
  return (
    <Section style={{ marginBottom: "28px" }}>
      <If value={brand.logoUrl}>
        <Img src={brand.logoUrl} alt={brand.productName} width="120" style={{ maxWidth: "120px", height: "auto" }} />
      </If>
      <Unless value={brand.logoUrl}>
        <Text className="dm-text" style={{ ...text, fontSize: "14px", fontWeight: "600", marginBottom: "0" }}>
          {brand.productName}
        </Text>
      </Unless>
    </Section>
  );
}

function Footer({ brand, reason, marketing }: { brand: Brand; reason: string; marketing?: boolean }) {
  const unsubscribeUrl = brand.unsubscribeUrl ?? "{{{UNSUBSCRIBE_URL}}}";
  const theme = emailTheme(brand);
  return (
    <Section className="dm-divider" style={{ borderTop: `1px solid ${theme.THEME_BORDER_COLOR}`, marginTop: "28px", paddingTop: "20px" }}>
      <Text className="dm-muted" style={{ ...muted, marginBottom: "8px" }}>{reason}</Text>
      {marketing ? <>
        <Text className="dm-muted" style={{ ...muted, marginBottom: "8px" }}>{brand.companyName}<br />{brand.companyAddress}</Text>
        <Text className="dm-muted" style={{ ...muted, marginBottom: "8px" }}>
          <Link className="dm-link" href={unsubscribeUrl} style={linkStyle(brand.color)}>Unsubscribe or manage preferences</Link>
        </Text>
      </> : null}
      <Text className="dm-muted" style={{ ...muted, marginBottom: "0" }}>
        <If value={brand.productUrl}><Link className="dm-link" href={brand.productUrl} style={linkStyle(brand.color)}>{brand.productName}</Link></If>
        <Unless value={brand.productUrl}>{brand.productName}</Unless>
        <If value={brand.supportUrl}>{" · "}<Link className="dm-link" href={brand.supportUrl} style={linkStyle(brand.color)}>Support</Link></If>
        <Unless value={brand.supportUrl}><If value={brand.supportEmail}>{" · "}<Link className="dm-link" href={`mailto:${brand.supportEmail}`} style={linkStyle(brand.color)}>Support</Link></If></Unless>
        <If value={brand.privacyUrl}>{" · "}<Link className="dm-link" href={brand.privacyUrl} style={linkStyle(brand.color)}>Privacy</Link></If>
      </Text>
    </Section>
  );
}

export function Layout({
  brand,
  preview,
  title,
  reason,
  marketing = false,
  children,
}: {
  brand: Brand;
  preview: string;
  title: string;
  reason: string;
  marketing?: boolean;
  children: React.ReactNode;
}) {
  // Every template defaults its brand to the sample one, so a preview needs no setup. A real
  // send with that default would go out branded "Example", so production refuses it.
  if (brand === exampleBrand && typeof process !== "undefined" && process.env.NODE_ENV === "production") {
    throw new Error('Pass a brand to this template. Without one it is branded "Example", which is only for previews.');
  }
  const theme = emailTheme(brand);
  return (
    <ThemeContext.Provider value={theme}>
    <Html lang="en" dir="ltr" className="dm-canvas" style={{ backgroundColor: theme.THEME_BACKGROUND_COLOR }}>
      <Head>
        <meta name="color-scheme" content="light dark" />
        <meta name="supported-color-schemes" content="light dark" />
        <title>{title}</title>
        <style>{darkModeCss + `
          @media only screen and (max-width: 600px) {
            .dm-padding { padding: 28px 20px !important; }
          }
        `}</style>
      </Head>
      <Body
        className="dm-canvas"
        style={{ fontFamily: theme.THEME_FONT_FAMILY, fontSize: theme.THEME_FONT_SIZE,
          margin: "0", padding: "24px 12px", lineHeight: "1.6", color: theme.THEME_TEXT_COLOR, backgroundColor: theme.THEME_BACKGROUND_COLOR }}
      >
        <Preview useTitleTag={false}>{preview}</Preview>
        <table role="presentation" align="center" width="100%" cellPadding={0} cellSpacing={0} border={0}
          className="dm-card dm-divider"
          style={{ width: "100%", maxWidth: "560px", tableLayout: "fixed", borderCollapse: "separate", overflow: "hidden", overflowWrap: "anywhere", wordWrap: "break-word", backgroundColor: theme.THEME_SURFACE_COLOR,
            border: `1px solid ${theme.THEME_BORDER_COLOR}`, borderRadius: theme.THEME_RADIUS }}>
          <tbody><tr><td className="dm-card dm-padding" style={{ padding: "36px 32px", borderRadius: theme.THEME_RADIUS }}>
          <Header brand={brand} />
          {children}
          <Footer brand={brand} reason={reason} marketing={marketing} />
          </td></tr></tbody>
        </table>
      </Body>
    </Html>
    </ThemeContext.Provider>
  );
}
