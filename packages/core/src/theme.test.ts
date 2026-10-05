import { describe, expect, it } from "vitest";
import { ApiError, assertBrandContrast, brandContext, brandSchema, contrast, emailFonts, reservedVariables, themeContext, themeVariables } from "./index.js";

describe("brand theme contracts", () => {
  it("validates token ranges and safe fonts, preserving legacy button meaning", () => {
    const brand = brandSchema.parse({ text_color: "#112233", color: "#ffffff", font_family: emailFonts[1], font_size: 18, radius: 0 });
    expect(brandContext(brand, { tenantName: "Test" })).toMatchObject({ THEME_TEXT_COLOR: "#112233", BRAND_TEXT_COLOR: "#000000", THEME_FONT_SIZE: "18px", THEME_RADIUS: "0px" });
    for (const value of [{ font_size: 13 }, { font_size: 19 }, { radius: 17 }, { radius: -1 }, { font_family: "url(https://unsafe)" }])
      expect(brandSchema.safeParse(value).success).toBe(false);
  });
  it("uses shared contrast for filled and outline buttons and reserves every token", () => {
    expect(contrast("#000000", "#ffffff")).toBe(21);
    expect(() => assertBrandContrast({ text_color: "#ffffff", background_color: "#ffffff" })).toThrow(ApiError);
    expect(() => assertBrandContrast({ color: "#eeeeee", button_style: "outline" })).toThrow(/Button text/);
    expect(() => assertBrandContrast({ color: "#eeeeee", button_style: "filled" })).not.toThrow();
    expect(themeContext({ color: "#123456", button_style: "outline" })).toMatchObject({
      THEME_BUTTON_BACKGROUND: "#ffffff", THEME_BUTTON_TEXT_COLOR: "#123456", THEME_BUTTON_BORDER: "1px solid #123456",
    });
    expect(themeVariables.every((name) => reservedVariables.includes(name))).toBe(true);
  });
});
