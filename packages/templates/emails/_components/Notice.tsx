import type React from "react";
import { Text } from "react-email";
import { muted } from "../_theme";

export function Notice({ children }: { children: React.ReactNode }) {
  return (
    <Text className="dm-muted" style={muted}>
      {children}
    </Text>
  );
}
