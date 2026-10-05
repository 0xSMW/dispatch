import type React from "react";
import { Body, Container, Head, Html, Img, Link, Preview, Section, Text } from "react-email";
import { dark, emailTheme, exampleBrand, light, linkStyle, muted, text, ThemeContext, type Brand } from "../_theme";
import { If } from "./If";

const darkModeCss = `
  .dm-canvas { background-color: ${light.canvas}; }
  .dm-card { background-color: ${light.card}; }
  @media (prefers-color-scheme: dark) {
    .dm-canvas { background-color: ${dark.canvas} !important; }
    .dm-card { background-color: ${dark.card} !important; }
    .dm-text { color: ${dark.text} !important; }
    .dm-muted { color: ${dark.muted} !important; }
    a.dm-link { color: ${dark.link} !important; }
  }
`;

function Header({ brand }: { brand: Brand }) {
  return (
    <Section>
      <If value={brand.logoUrl}>
        <Link className="dm-link" href={brand.productUrl} style={linkStyle(brand.color)}>
          <Img src={brand.logoUrl} alt={brand.productName} width="120" />
        </Link>
      </If>
      <Text className="dm-text" style={{ ...text, fontWeight: "600" }}>
        {brand.productName}
      </Text>
    </Section>
  );
}

function Footer({ brand, reason, marketing }: { brand: Brand; reason: string; marketing?: boolean }) {
  const unsubscribeUrl = brand.unsubscribeUrl ?? "{{{UNSUBSCRIBE_URL}}}";
  const year = brand.year ?? String(new Date().getFullYear());
  return (
    <Section>
      <Text className="dm-muted" style={muted}>
        {brand.companyName}
      </Text>
      <If value={brand.productUrl}>
        <Text className="dm-muted" style={muted}>
          <Link className="dm-link" href={brand.productUrl} style={linkStyle(brand.color)}>
            {brand.productName}
          </Link>
        </Text>
        <Text className="dm-muted" style={muted}>
          {brand.productUrl}
        </Text>
      </If>
      <If value={brand.supportUrl}>
        <Text className="dm-muted" style={muted}>
          <Link className="dm-link" href={brand.supportUrl} style={linkStyle(brand.color)}>
            Contact support
          </Link>
        </Text>
        <Text className="dm-muted" style={muted}>
          {brand.supportUrl}
        </Text>
      </If>
      <If value={brand.supportEmail}>
        <Text className="dm-muted" style={muted}>
          Support email {brand.supportEmail}
        </Text>
      </If>
      <If value={brand.privacyUrl}>
        <Text className="dm-muted" style={muted}>
          <Link className="dm-link" href={brand.privacyUrl} style={linkStyle(brand.color)}>
            Privacy policy
          </Link>
        </Text>
        <Text className="dm-muted" style={muted}>
          {brand.privacyUrl}
        </Text>
      </If>
      <Text className="dm-muted" style={muted}>
        {reason}
      </Text>
      {marketing ? (
        <>
          <Text className="dm-muted" style={muted}>
            {brand.companyAddress}
          </Text>
          <Text className="dm-muted" style={muted}>
            <Link className="dm-link" href={unsubscribeUrl} style={linkStyle(brand.color)}>
              Unsubscribe
            </Link>
          </Text>
          <Text className="dm-muted" style={muted}>
            <Link className="dm-link" href={unsubscribeUrl} style={linkStyle(brand.color)}>
              Manage preferences
            </Link>
          </Text>
          <Text className="dm-muted" style={muted}>
            {unsubscribeUrl}
          </Text>
        </>
      ) : null}
      <Text className="dm-muted" style={muted}>
        © {year} {brand.companyName}
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
    <Html lang="en" dir="ltr">
      <Head>
        <meta name="color-scheme" content="light dark" />
        <meta name="supported-color-schemes" content="light dark" />
        <title>{title}</title>
        <style>{brand.theme ? `
          .dm-canvas { background-color: ${theme.THEME_BACKGROUND_COLOR}; }
          .dm-card { background-color: ${theme.THEME_SURFACE_COLOR}; }
        ` : darkModeCss}</style>
      </Head>
      <Body
        className="dm-canvas"
        style={{ fontFamily: theme.THEME_FONT_FAMILY, fontSize: theme.THEME_FONT_SIZE,
          lineHeight: "1.5", color: theme.THEME_TEXT_COLOR, backgroundColor: theme.THEME_BACKGROUND_COLOR }}
      >
        <Preview useTitleTag={false}>{preview}</Preview>
        <Container
          className="dm-card"
          tdClassName="dm-card"
          style={{ maxWidth: "600px", backgroundColor: theme.THEME_SURFACE_COLOR, padding: "32px 24px",
            border: `1px solid ${theme.THEME_BORDER_COLOR}`, borderRadius: theme.THEME_RADIUS }}
        >
          <Header brand={brand} />
          {children}
          <Footer brand={brand} reason={reason} marketing={marketing} />
        </Container>
      </Body>
    </Html>
    </ThemeContext.Provider>
  );
}
