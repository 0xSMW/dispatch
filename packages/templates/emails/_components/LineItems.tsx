import { Img } from "react-email";
import { Each } from "./Each";
import { If } from "./If";
import { muted, useTheme, type Brand } from "../_theme";

export type LineItem = {
  description: string;
  quantity: string;
  amount: string;
  image_url?: string;
};

const cell = {
  lineHeight: "1.5",
  padding: "8px 12px 8px 0",
  verticalAlign: "top" as const,
};

export function LineItems({ items, showImage = false, brand }: { items: LineItem[]; showImage?: boolean; brand?: Brand }) {
  const theme = useTheme(brand);
  const style = { fontFamily: theme.THEME_FONT_FAMILY, fontSize: theme.THEME_FONT_SIZE, color: theme.THEME_TEXT_COLOR };
  return (
    <table role="presentation" width="100%" cellPadding={0} cellSpacing={0} border={0} style={{ marginBottom: "16px" }}>
      <tbody>
        <tr>
          <td className="dm-muted" style={{ ...muted, ...style, padding: "4px 12px 8px 0" }}>
            Description
          </td>
          <td className="dm-muted" style={{ ...muted, ...style, padding: "4px 12px 8px 0" }}>
            Quantity
          </td>
          <td className="dm-muted" style={{ ...muted, ...style, padding: "4px 0 8px 0" }}>
            Amount
          </td>
        </tr>
        <Each items={items}>
          {(item) => (
            <tr>
              <td className="dm-text" style={{ ...cell, ...style }}>
                {showImage ? (
                  <If value={item.image_url}>
                    <Img src={item.image_url} alt={item.description} width="48" />
                  </If>
                ) : null}
                {item.description}
              </td>
              <td className="dm-text" style={{ ...cell, ...style }}>
                {item.quantity}
              </td>
              <td className="dm-text" style={{ ...cell, ...style, paddingRight: "0" }}>
                {item.amount}
              </td>
            </tr>
          )}
        </Each>
      </tbody>
    </table>
  );
}
