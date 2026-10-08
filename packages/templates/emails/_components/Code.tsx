import type React from "react";
import { Text } from "react-email";
import { useTheme, type Brand } from "../_theme";

const code = {
  letterSpacing: "4px",
  lineHeight: "1.5",
  marginTop: "0",
  marginBottom: "16px",
};

export function Code({ children, brand }: { children: React.ReactNode; brand?: Brand }) {
  const theme = useTheme(brand);
  return (
    <Text className="dm-text dm-divider" style={{ ...code, fontSize: "28px", fontWeight: "600", padding: "16px 20px", border: `1px solid ${theme.THEME_BORDER_COLOR}`, borderRadius: theme.THEME_RADIUS,
      fontFamily: theme.THEME_FONT_FAMILY, color: theme.THEME_TEXT_COLOR }}>
      {children}
    </Text>
  );
}
