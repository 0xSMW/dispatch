import { z } from "zod";

export const emailFonts = [
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
  "Arial, Helvetica, sans-serif",
  "Georgia, 'Times New Roman', serif",
  "'Courier New', Courier, monospace",
] as const;
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
export const themeSchema = z.object({
  text_color: color.optional(), background_color: color.optional(), surface_color: color.optional(), border_color: color.optional(),
  font_family: z.enum(emailFonts).optional(), font_size: z.number().int().min(14).max(18).optional(),
  radius: z.number().int().min(0).max(16).optional(), button_style: z.enum(["filled", "outline"]).optional(),
});
export const themeDefaults = {
  text_color: "#18181b", background_color: "#f4f4f5", surface_color: "#ffffff", border_color: "#e4e4e7",
  font_family: emailFonts[0], font_size: 16, radius: 8, button_style: "filled" as "filled" | "outline",
};
export type ThemeTokens = typeof themeDefaults;
export const themeVariables = [
  "THEME_TEXT_COLOR", "THEME_BACKGROUND_COLOR", "THEME_SURFACE_COLOR", "THEME_BORDER_COLOR",
  "THEME_FONT_FAMILY", "THEME_FONT_SIZE", "THEME_RADIUS", "THEME_BUTTON_STYLE",
  "THEME_BUTTON_BACKGROUND", "THEME_BUTTON_TEXT_COLOR", "THEME_BUTTON_BORDER",
];
export type LibraryUpdateItem = { id: string; name: string; slug: string; reason?: string };
export type LibraryUpdates = { updated: LibraryUpdateItem[]; skipped: LibraryUpdateItem[] };
