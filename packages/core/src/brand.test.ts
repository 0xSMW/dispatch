import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { brandSchema } from "./brand.js";

const copyLimits = {
  unsubscribe_title: 120,
  unsubscribe_description: 500,
  unsubscribe_button_label: 80,
  unsubscribe_updated_title: 120,
  unsubscribe_updated_description: 500,
  unsubscribe_unsubscribed_title: 120,
  unsubscribe_unsubscribed_description: 500,
};

describe("unsubscribe brand settings", () => {
  it("accepts optional nullable copy with exact length bounds", () => {
    expect(brandSchema.parse({})).toEqual({});
    for (const [field, max] of Object.entries(copyLimits)) {
      for (const value of [null, "a", "a".repeat(max)])
        expect(brandSchema.parse({ [field]: value })).toEqual({ [field]: value });
      for (const value of ["", "a".repeat(max + 1), 1])
        expect(brandSchema.safeParse({ [field]: value }).success).toBe(false);
    }
  });

  it("accepts nullable HTTPS logos and six-digit hex page colors", () => {
    for (const value of [null, "https://example.com/logo.png"])
      expect(brandSchema.safeParse({ unsubscribe_logo_url: value }).success).toBe(true);
    for (const value of ["", "http://example.com/logo.png", "javascript:alert(1)", "example.com"])
      expect(brandSchema.safeParse({ unsubscribe_logo_url: value }).success).toBe(false);
    for (const value of [null, "#112233", "#AbCdEf"])
      expect(brandSchema.safeParse({ unsubscribe_color: value }).success).toBe(true);
    for (const value of ["", "#fff", "112233", "#12345678", "#gggggg"])
      expect(brandSchema.safeParse({ unsubscribe_color: value }).success).toBe(false);
  });

  it("documents the same nullable settings and public response contract", () => {
    const spec = JSON.parse(readFileSync(new URL("../../../docs/api/openapi.json", import.meta.url), "utf8"));
    for (const name of ["Brand", "BrandUpdate"]) {
      const properties = spec.components.schemas[name].properties;
      for (const [field, maxLength] of Object.entries(copyLimits))
        expect(properties[field]).toMatchObject({ type: ["string", "null"], minLength: 1, maxLength });
      expect(properties.unsubscribe_logo_url).toMatchObject({ type: ["string", "null"], format: "uri", pattern: "^https://" });
      expect(properties.unsubscribe_color).toMatchObject({ type: ["string", "null"], pattern: "^#[0-9a-fA-F]{6}$" });
    }
    const publicBrand = spec.components.schemas.Preferences.properties.brand;
    for (const field of Object.keys(copyLimits).map((key) => key.replace("unsubscribe_", ""))) {
      expect(publicBrand.properties[field]).toMatchObject({ type: ["string", "null"] });
      expect(publicBrand.required).toContain(field);
    }
  });
});
