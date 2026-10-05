import { describe, expect, it } from "vitest";
import { brandContext, themeVariables } from "@dispatchmail/core";
import { brandValues, reservedVariables } from "./render";
describe("theme preview contract", () => {
  it("agrees on reserved names and body versus legacy button colors", () => {
    expect(themeVariables.every((name) => reservedVariables.includes(name))).toBe(true);
    const brand = { color: "#ffffff", text_color: "#123456", font_size: 18, radius: 0 };
    expect(brandValues(brand)).toMatchObject({
      BRAND_TEXT_COLOR: "#000000", THEME_TEXT_COLOR: "#123456", THEME_FONT_SIZE: "18px", THEME_RADIUS: "0px",
    });
    const server = brandContext(brand, { tenantName: "Test" });
    expect(brandValues({ variables: server })).toEqual(server);
  });
});
