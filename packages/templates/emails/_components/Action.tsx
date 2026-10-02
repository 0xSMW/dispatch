import type React from "react";
import { Link, Text } from "react-email";
import { fontFamily, linkStyle, muted, text, type Brand } from "../_theme";

export function Action({ brand, href, children }: { brand: Brand; href?: string; children: React.ReactNode }) {
  const url = href ?? "";
  return (
    <>
      <table role="presentation" cellPadding={0} cellSpacing={0} border={0} style={{ margin: "8px 0 16px" }}>
        <tbody>
          <tr>
            <td style={{ borderRadius: "6px", backgroundColor: brand.color }}>
              <a
                href={url}
                style={{
                  backgroundColor: brand.color,
                  borderRadius: "6px",
                  color: brand.textColor,
                  display: "inline-block",
                  fontFamily,
                  fontSize: "16px",
                  lineHeight: "20px",
                  minHeight: "44px",
                  padding: "12px 20px",
                  textDecoration: "none",
                }}
              >
                {children}
              </a>
            </td>
          </tr>
        </tbody>
      </table>
      <Text className="dm-muted" style={muted}>
        {url}
      </Text>
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
      <Text className="dm-muted" style={muted}>
        {url}
      </Text>
    </>
  );
}
