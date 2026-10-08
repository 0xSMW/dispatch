import { z } from "zod";
import { ApiError } from "./errors.js";
import { themeDefaults, themeSchema, type ThemeTokens } from "./theme.js";
export * from "./theme.js";
const httpsUrl = z.string().url().refine((value) => value.startsWith("https://"), "must be an https url");
export const brandSchema = z.object({
  product_name: z.string().min(1).max(120).optional(), product_url: httpsUrl.optional(),
  logo_url: httpsUrl.nullable().optional(), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  support_email: z.string().email().optional(), support_url: httpsUrl.nullable().optional(),
  company_name: z.string().min(1).max(200).optional(), company_address: z.string().max(500).optional(),
  privacy_url: httpsUrl.nullable().optional(),
  unsubscribe_title: z.string().min(1).max(120).nullable().optional(),
  unsubscribe_description: z.string().min(1).max(500).nullable().optional(),
  unsubscribe_button_label: z.string().min(1).max(80).nullable().optional(),
  unsubscribe_updated_title: z.string().min(1).max(120).nullable().optional(),
  unsubscribe_updated_description: z.string().min(1).max(500).nullable().optional(),
  unsubscribe_unsubscribed_title: z.string().min(1).max(120).nullable().optional(),
  unsubscribe_unsubscribed_description: z.string().min(1).max(500).nullable().optional(),
  unsubscribe_logo_url: httpsUrl.nullable().optional(),
  unsubscribe_color: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
}).merge(themeSchema).strict();
export type BrandInput = z.infer<typeof brandSchema>;
export type BrandRecord = BrandInput;
function channel(hex: string) {
  const value = Number.parseInt(hex, 16) / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}
function luminance(color: string) {
  const hex = color.replace("#", "");
  return 0.2126 * channel(hex.slice(0, 2)) + 0.7152 * channel(hex.slice(2, 4)) + 0.0722 * channel(hex.slice(4, 6));
}
export function contrast(left: string, right: string) {
  const lighter = Math.max(luminance(left), luminance(right));
  const darker = Math.min(luminance(left), luminance(right));
  return (lighter + 0.05) / (darker + 0.05);
}
export function brandTextColor(color: string) {
  return contrast(color, "#ffffff") >= contrast(color, "#000000") ? "#ffffff" : "#000000";
}
export function resolvedTheme(brand: BrandRecord): ThemeTokens {
  return { ...themeDefaults, ...Object.fromEntries(Object.keys(themeDefaults).filter((key) => brand[key as keyof ThemeTokens] !== undefined)
    .map((key) => [key, brand[key as keyof ThemeTokens]])) };
}
export function themeContext(brand: BrandRecord) {
  const theme = resolvedTheme(brand);
  const color = brand.color || "#171717";
  const outline = theme.button_style === "outline";
  return {
    THEME_TEXT_COLOR: theme.text_color, THEME_BACKGROUND_COLOR: theme.background_color,
    THEME_SURFACE_COLOR: theme.surface_color, THEME_BORDER_COLOR: theme.border_color,
    THEME_FONT_FAMILY: theme.font_family, THEME_FONT_SIZE: `${theme.font_size}px`, THEME_RADIUS: `${theme.radius}px`,
    THEME_BUTTON_STYLE: theme.button_style, THEME_BUTTON_BACKGROUND: outline ? theme.surface_color : color,
    THEME_BUTTON_TEXT_COLOR: outline ? color : brandTextColor(color), THEME_BUTTON_BORDER: `1px solid ${color}`,
  };
}
export function assertBrandContrast(brand: BrandRecord) {
  const theme = resolvedTheme(brand);
  const vars = themeContext(brand);
  if (contrast(theme.text_color, theme.background_color) < 4.5 || contrast(theme.text_color, theme.surface_color) < 4.5)
    throw new ApiError("validation_error", 422, "Text must reach 4.5:1 contrast on the background and surface");
  if (contrast(vars.THEME_BUTTON_TEXT_COLOR, vars.THEME_BUTTON_BACKGROUND) < 4.5)
    throw new ApiError("validation_error", 422, "Button text must reach 4.5:1 contrast on the button");
}
