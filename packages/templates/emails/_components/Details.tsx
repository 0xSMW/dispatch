import type React from "react";
import { muted, text, useTheme, type Brand } from "../_theme";

export function Details({ rows, brand }: { rows: Array<{ label: string; value: React.ReactNode }>; brand?: Brand }) {
  const theme = useTheme(brand);
  const style = { fontFamily: theme.THEME_FONT_FAMILY, fontSize: theme.THEME_FONT_SIZE, color: theme.THEME_TEXT_COLOR };
  return (
    <table
      role="presentation"
      width="100%"
      cellPadding={0}
      cellSpacing={0}
      border={0}
      style={{ marginBottom: "16px" }}
    >
      <tbody>
        {rows.map((row) => (
          <tr key={row.label}>
            <td
              className="dm-muted"
              style={{ ...muted, ...style, width: "160px", padding: "4px 12px 4px 0" }}
            >
              {row.label}
            </td>
            <td className="dm-text" style={{ ...text, ...style, marginBottom: "0", padding: "4px 0" }}>
              {row.value}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
