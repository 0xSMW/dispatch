import type React from "react";
import { Link, Text } from "react-email";
import { linkStyle, text, useTheme, type Brand } from "../_theme";

export function Action({ brand, href, children }: { brand: Brand; href?: string; children: React.ReactNode }) {
  const url = href ?? "";
  const theme = useTheme(brand);
  return (
    <>
      <table role="presentation" cellPadding={0} cellSpacing={0} border={0} style={{ margin: "24px 0" }}>
        <tbody>
          <tr>
            <td className="dm-button" style={{ borderRadius: theme.THEME_RADIUS, backgroundColor: theme.THEME_BUTTON_BACKGROUND }}>
              <a
                href={url}
                className="dm-button"
                style={{
                  backgroundColor: theme.THEME_BUTTON_BACKGROUND,
                  borderRadius: theme.THEME_RADIUS,
                  border: theme.THEME_BUTTON_BORDER,
                  color: theme.THEME_BUTTON_TEXT_COLOR,
                  display: "inline-block",
                  fontFamily: theme.THEME_FONT_FAMILY,
                  fontSize: theme.THEME_FONT_SIZE,
                  lineHeight: "20px",
                  fontWeight: "600",
                  padding: "11px 20px",
                  textDecoration: "none",
                }}
              >
                {children}
              </a>
            </td>
          </tr>
        </tbody>
      </table>
    </>
  );
}

export function TextLink({
  brand,
  href,
  children,
}: {
  brand: Brand;
  href?: string;
  children: React.ReactNode;
}) {
  const url = href ?? "";
  return (
    <>
      <Text className="dm-text" style={text}>
        <Link className="dm-link" href={url} style={linkStyle(brand.color)}>
          {children}
        </Link>
      </Text>
    </>
  );
}
