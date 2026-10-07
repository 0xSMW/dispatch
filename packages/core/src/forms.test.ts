import { describe, expect, it } from "vitest";
import { formSchema, formSubmissionSchema, formUpdateSchema } from "./forms.js";
import { settingsSchema } from "./index.js";

const input = { name: "Newsletter", topic_ids: ["topic_1"], from_email: "hello@example.com", allowed_origins: ["https://example.com"] };
describe("forms contract", () => {
  it("defaults consent on and permits only configured HTTPS redirects and exact origins", () => {
    expect(formSchema.parse(input)).toMatchObject({ double_opt_in: true, properties: [], redirect_url: null });
    for (const redirect_url of ["http://example.com", "javascript:alert(1)", "https://user:pass@example.com"])
      expect(formSchema.safeParse({ ...input, redirect_url }).success).toBe(false);
    for (const origin of ["*", "null", "https://example.com/path", "https://example.com/"])
      expect(formSchema.safeParse({ ...input, allowed_origins: [origin] }).success).toBe(false);
    expect(formUpdateSchema.parse({ double_opt_in: false, redirect_url: null })).toEqual({ double_opt_in: false, redirect_url: null });
  });
  it("rejects reserved property keys and normalizes mailbox case", () => {
    for (const key of ["email", "website", "constructor", "__proto__"])
      expect(formSchema.safeParse({ ...input, properties: [key] }).success).toBe(false);
    expect(formSubmissionSchema.parse({ email: "Person@EXAMPLE.com" }).email).toBe("person@example.com");
  });
  it("limits configurable confirmation sends, including explicit off", () => {
    expect(settingsSchema.parse({}).confirmation_daily_limit).toBe(500);
    expect(settingsSchema.parse({ confirmation_daily_limit: 0 }).confirmation_daily_limit).toBe(0);
    for (const confirmation_daily_limit of [-1, 1.5, 100001, "500"])
      expect(settingsSchema.safeParse({ confirmation_daily_limit }).success).toBe(false);
  });
});
