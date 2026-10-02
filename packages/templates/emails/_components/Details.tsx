import type React from "react";
import { fontFamily, muted, text } from "../_theme";

export function Details({ rows }: { rows: Array<{ label: string; value: React.ReactNode }> }) {
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
              style={{ ...muted, fontFamily, width: "160px", padding: "4px 12px 4px 0" }}
            >
              {row.label}
            </td>
            <td className="dm-text" style={{ ...text, marginBottom: "0", padding: "4px 0" }}>
              {row.value}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
