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
    <table role="presentation" width="100%" cellPadding={0} cellSpacing={0} border={0} style={{ margin: "20px 0", tableLayout: "fixed" }}>
      <tbody>
        <tr>
          <td className="dm-muted dm-divider" style={{ ...muted, ...style, fontSize: "12px", padding: "8px 12px 12px 0", borderBottom: `1px solid ${theme.THEME_BORDER_COLOR}` }}>
            Description
          </td>
          <td className="dm-muted dm-divider" style={{ ...muted, ...style, fontSize: "12px", padding: "8px 12px 12px 0", borderBottom: `1px solid ${theme.THEME_BORDER_COLOR}` }}>
            Qty
          </td>
          <td className="dm-muted dm-divider" style={{ ...muted, ...style, fontSize: "12px", textAlign: "right", padding: "8px 0 12px 0", borderBottom: `1px solid ${theme.THEME_BORDER_COLOR}` }}>
            Amount
          </td>
        </tr>
        <Each items={items}>
          {(item) => (
            <tr>
              <td className="dm-text" style={{ ...cell, ...style, overflowWrap: "anywhere" }}>
                {showImage ? (
                  <If value={item.image_url}>
                    <Img src={item.image_url} alt={item.description} width="48" />
                  </If>
                ) : null}
                {item.description}
              </td>
              <td className="dm-text" style={{ ...cell, ...style, overflowWrap: "anywhere" }}>
                {item.quantity}
              </td>
              <td className="dm-text" style={{ ...cell, ...style, paddingRight: "0", textAlign: "right" }}>
                {item.amount}
              </td>
            </tr>
          )}
        </Each>
      </tbody>
    </table>
  );
}
