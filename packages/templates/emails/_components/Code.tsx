import type React from "react";
import { Text } from "react-email";
import { light } from "../_theme";

const code = {
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  fontSize: "32px",
  letterSpacing: "4px",
  lineHeight: "1.5",
  color: light.text,
  marginTop: "0",
  marginBottom: "16px",
};

export function Code({ children }: { children: React.ReactNode }) {
  return (
    <Text className="dm-text" style={code}>
      {children}
    </Text>
  );
}
