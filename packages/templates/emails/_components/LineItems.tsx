import { Img } from "react-email";
import { Each } from "./Each";
import { If } from "./If";
import { fontFamily, light, muted } from "../_theme";

export type LineItem = {
  description: string;
  quantity: string;
  amount: string;
  image_url?: string;
};

const cell = {
  fontFamily,
  fontSize: "16px",
  lineHeight: "1.5",
  color: light.text,
  padding: "8px 12px 8px 0",
  verticalAlign: "top" as const,
};

export function LineItems({ items, showImage = false }: { items: LineItem[]; showImage?: boolean }) {
  return (
    <table role="presentation" width="100%" cellPadding={0} cellSpacing={0} border={0} style={{ marginBottom: "16px" }}>
      <tbody>
        <tr>
          <td className="dm-muted" style={{ ...muted, padding: "4px 12px 8px 0" }}>
            Description
          </td>
          <td className="dm-muted" style={{ ...muted, padding: "4px 12px 8px 0" }}>
            Quantity
          </td>
          <td className="dm-muted" style={{ ...muted, padding: "4px 0 8px 0" }}>
            Amount
          </td>
        </tr>
        <Each items={items}>
          {(item) => (
            <tr>
              <td className="dm-text" style={cell}>
                {showImage ? (
                  <If value={item.image_url}>
                    <Img src={item.image_url} alt={item.description} width="48" />
                  </If>
                ) : null}
                {item.description}
              </td>
              <td className="dm-text" style={cell}>
                {item.quantity}
              </td>
              <td className="dm-text" style={{ ...cell, paddingRight: "0" }}>
                {item.amount}
              </td>
            </tr>
          )}
        </Each>
      </tbody>
    </table>
  );
}
