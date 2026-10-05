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
    <Text className="dm-text" style={{ ...code, fontSize: theme.THEME_FONT_SIZE,
      fontFamily: theme.THEME_FONT_FAMILY, color: theme.THEME_TEXT_COLOR }}>
      {children}
    </Text>
  );
}
