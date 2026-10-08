import { createElement, type ComponentType } from "react";
import { render } from "react-email";
import { describe, expect, it } from "vitest";
import { assertBrandContrast, brandContext, brandSchema, brandTextColor, emailFonts, renderTemplate, reservedVariables, themeContext, themeDefaults, themeVariables } from "@dispatchmail/core";
import { emailTheme, exampleBrand, themePlaceholders, type Brand } from "../emails/_theme";
import PasswordReset from "../emails/password-reset";
import OneTimeCode from "../emails/one-time-code";
import Receipt from "../emails/receipt";

const tokens = {
  color: "#173e70", text_color: "#152438", background_color: "#eef4fa",
  surface_color: "#ffffff", border_color: "#6f87a0",
  font_family: emailFonts[2], font_size: 18, radius: 13, button_style: "outline" as const,
};
const context = brandContext(tokens, { tenantName: "Acme" });
const brand: Brand = { ...exampleBrand, color: "{{{BRAND_COLOR}}}", textColor: "{{{BRAND_TEXT_COLOR}}}", theme: themePlaceholders };

async function rendered<P extends { brand?: Brand }>(component: ComponentType<P>, props: Omit<P, "brand">) {
  const html = await render(createElement(component, { ...props, brand } as P));
  return { html, filled: renderTemplate({ subject: "", html, text: "", variables: [] }, {}, context).html! };
}

describe("email theme tokens", () => {
  it("keeps safe font, size and radius bounds and reserves all theme names", () => {
    expect(brandSchema.parse(tokens)).toEqual(tokens);
    for (const invalid of [{ font_size: 13 }, { font_size: 19 }, { radius: -1 }, { radius: 17 }, { font_family: "Comic Sans" }]) {
      expect(brandSchema.safeParse(invalid).success).toBe(false);
    }
    expect(themeVariables.every((key) => reservedVariables.includes(key))).toBe(true);
    expect(themeContext({}).THEME_FONT_SIZE).toBe(`${themeDefaults.font_size}px`);
    expect(emailTheme(exampleBrand).THEME_BUTTON_BACKGROUND).toBe(exampleBrand.color);
    expect(context.BRAND_TEXT_COLOR).toBe(brandTextColor(tokens.color));
    expect(context.THEME_BUTTON_TEXT_COLOR).toBe(tokens.color);
  });

  it("refuses low text and outline button contrast", () => {
    expect(() => assertBrandContrast(tokens)).not.toThrow();
    expect(() => assertBrandContrast({ text_color: "#eeeeee" })).toThrow(/contrast/);
    expect(() => assertBrandContrast({ color: "#eeeeee", button_style: "outline" })).toThrow(/Button/);
  });

  it("substitutes nondefault tokens into real recipe HTML and outlined action styles", async () => {
    const { html, filled } = await rendered(PasswordReset, { actionUrl: "https://example.com/reset" });
    expect(html).toContain("font-size:{{{THEME_FONT_SIZE}}}");
    expect(html).not.toContain("{{{THEME_FONT_SIZE}}}px");
    for (const css of ["background-color:#eef4fa", "background-color:#ffffff", "color:#152438",
      "border:1px solid #6f87a0", "border-radius:13px", "font-size:18px",
      "background-color:#ffffff;border-radius:13px;border:1px solid #173e70;color:#173e70"]) {
      expect(filled).toContain(css);
    }
    expect(filled).toContain("Georgia");
    expect(filled).not.toContain("{{{THEME_");
    expect(filled).toContain("#0a0a0a !important");
  });

  it("themes code, details and line items in real rendered recipes", async () => {
    const code = await rendered(OneTimeCode, { code: "123456" });
    const codeStyle = code.filled.match(/<p[^>]*style="([^"]*)"[^>]*>123456<\/p>/)?.[1] ?? "";
    for (const css of ["font-size:28px", "letter-spacing:4px", "font-family:Georgia", "color:#152438"]) {
      expect(codeStyle).toContain(css);
    }
    const receipt = await rendered(Receipt, { receiptNumber: "42", paidAt: "Today", total: "$1",
      lineItems: [{ description: "Item", quantity: "1", amount: "$1" }] });
    for (const label of ["Receipt", "Item"]) {
      const style = receipt.filled.match(new RegExp(`<td[^>]*style="([^"]*)"[^>]*>${label}<\\/td>`))?.[1] ?? "";
      for (const css of ["font-size:18px", "font-family:Georgia", "color:#152438"]) expect(style).toContain(css);
    }
    expect(receipt.filled).not.toContain("{{{THEME_");
  });

  it("renders legacy brands without unresolved theme placeholders", async () => {
    const html = await render(createElement(PasswordReset, {
      actionUrl: "https://example.com/reset", brand: { ...exampleBrand },
    }));
    expect(html).not.toContain("{{{THEME_");
    expect(html).toContain("font-size:16px");
    expect(html).toContain("background-color:#171717");
    expect(html).toContain("color:#ffffff");
  });
});
