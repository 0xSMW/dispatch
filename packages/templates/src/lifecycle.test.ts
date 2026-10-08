import { emailFonts, renderTemplate, reservedVariables, templateSchema, themeContext } from "@dispatchmail/core";
import { describe, expect, it } from "vitest";
import library from "../library.json";
import {
  CardUpdateReminder, ComeBackOffer, ConfirmSubscription, FeatureTips, NewsletterWelcome,
  SetupReminder, SubscriptionCanceled, UpgradeInvite, WeMissYou,
} from "./index";
import { themePairs } from "../emails/_theme";
import { checkLibrary, checkTemplateVariables } from "./check";
import { stages } from "./types";

const marketing = [
  ["newsletter-welcome", NewsletterWelcome, "acquisition"],
  ["setup-reminder", SetupReminder, "onboarding"],
  ["feature-tips", FeatureTips, "onboarding"],
  ["upgrade-invite", UpgradeInvite, "retention"],
  ["we-miss-you", WeMissYou, "reengagement"],
  ["come-back-offer", ComeBackOffer, "reactivation"],
] as const;

const entry = (slug: string) => {
  const found = library.templates.find((item) => item.slug === slug);
  expect(found, `missing ${slug}`).toBeDefined();
  return structuredClone(found!);
};

const brand = {
  PRODUCT_NAME: "Acme",
  PRODUCT_URL: "https://acme.example",
  LOGO_URL: "",
  BRAND_COLOR: "#18181b",
  BRAND_TEXT_COLOR: "#ffffff",
  ...themeContext({ color: "#18181b" }),
  SUPPORT_EMAIL: "support@acme.example",
  SUPPORT_URL: "https://acme.example/support",
  PRIVACY_URL: "https://acme.example/privacy",
  COMPANY_NAME: "Acme, Inc.",
  COMPANY_ADDRESS: "1 Main Street, Springfield",
  CURRENT_YEAR: "2026",
  UNSUBSCRIBE_URL: "https://acme.example/unsubscribe/token",
};

describe("lifecycle sources and metadata", () => {
  it.each(marketing)("%s exports its source metadata and renders safely without event variables", (slug, component, stage) => {
    const item = entry(slug);
    expect(component.Kind).toBe("marketing");
    expect(component.Stage).toBe(stage);
    expect(item.kind).toBe(component.Kind);
    expect(item.stage).toBe(component.Stage);
    expect(item.when).toBe(component.When);
    expect(item.when.trim()).not.toBe("");
    expect(checkTemplateVariables(item, [])).toEqual([]);
    const rendered = renderTemplate(item, {}, brand);
    expect(rendered.html).toContain('href="https://acme.example"');
    expect(rendered.html).toContain('href="https://acme.example/unsubscribe/token"');
    expect(rendered.html).toContain(brand.COMPANY_ADDRESS);
    expect(rendered.text).toContain(brand.UNSUBSCRIBE_URL);
    expect(rendered.text).toContain(brand.COMPANY_ADDRESS);
    expect(rendered.text).toContain("Hi there");
    expect(JSON.stringify(rendered)).not.toContain("{{{");
  });

  it.each(marketing)("%s uses recipient context and an optional custom action", (slug) => {
    const rendered = renderTemplate(entry(slug), { ACTION_URL: "https://acme.example/next" }, { ...brand, FIRST_NAME: "Ada" });
    expect(rendered.text).toContain("Hi Ada");
    expect(rendered.html).toContain('href="https://acme.example/next"');
    expect(rendered.html).not.toMatch(/href=""|href="\{\{\{/);
  });

  it("does not turn recipient names or offers into HTML", () => {
    const rendered = renderTemplate(entry("come-back-offer"), {
      FIRST_NAME: '<img src="x" onerror="alert(1)">',
      OFFER: "<script>alert(1)</script> & savings",
    }, brand);
    expect(rendered.html).toContain("&lt;img");
    expect(rendered.html).toContain("&lt;script&gt;alert(1)&lt;/script&gt; &amp; savings");
    expect(rendered.html).not.toContain("<script>");
    expect(rendered.text).toContain("<script>alert(1)</script> & savings");
  });

  it.each([
    ["card-update-reminder", CardUpdateReminder],
    ["subscription-canceled", SubscriptionCanceled],
  ] as const)("%s uses only approved payment inputs or fallbacks", (slug, component) => {
    const item = entry(slug);
    expect(item.kind).toBe("transactional");
    expect(item.stage).toBe("dunning");
    expect(item.when).toBe(component.When);
    expect(component.Kind).toBe(item.kind);
    expect(component.Stage).toBe(item.stage);
    expect(item.variables.every((variable) => ["AMOUNT", "UPDATE_PAYMENT_URL", "INVOICE_NUMBER"].includes(variable.key))).toBe(true);
    expect(checkTemplateVariables(item, ["AMOUNT", "UPDATE_PAYMENT_URL", "INVOICE_NUMBER"])).toEqual([]);
    const rendered = renderTemplate(item, { AMOUNT: "$49.00", UPDATE_PAYMENT_URL: "https://acme.example/invoices/1042" }, brand);
    expect(rendered.html).toContain('href="https://acme.example/invoices/1042"');
    expect(rendered.html).not.toContain("unsubscribe/token");
    expect(JSON.stringify(rendered)).not.toContain("{{{");
  });

  it("preserves the original payment-failed required names and supplied-data render", () => {
    const item = entry("payment-failed");
    expect(item.variables.filter((variable) => variable.fallback_value === null).map((variable) => variable.key)).toEqual([
      "AMOUNT", "UPDATE_PAYMENT_URL",
    ]);
    expect(checkTemplateVariables(item, ["AMOUNT", "UPDATE_PAYMENT_URL", "INVOICE_NUMBER"])).toEqual([]);
    const rendered = renderTemplate(item, { AMOUNT: "$49.00", UPDATE_PAYMENT_URL: "https://acme.example/pay" }, brand);
    expect(rendered.text).toContain("$49.00");
    expect(rendered.html).toContain('href="https://acme.example/pay"');
  });

  it("confirmation is transactional, untracked, stage-less and uses the form's CONFIRM_URL", () => {
    const item = entry("confirm-subscription");
    expect(item.kind).toBe(ConfirmSubscription.Kind);
    expect(item.kind).toBe("transactional");
    expect(item.stage).toBeNull();
    expect(item.when).toBe(ConfirmSubscription.When);
    expect(item.track).toBe(false);
    expect(item.variables.filter((variable) => variable.fallback_value === null).map((variable) => variable.key)).toEqual(["CONFIRM_URL"]);
    expect(checkTemplateVariables(item, ["CONFIRM_URL"])).toEqual([]);
    const rendered = renderTemplate(item, { CONFIRM_URL: "https://acme.example/confirm/token" }, brand);
    expect(rendered.html).toContain('href="https://acme.example/confirm/token"');
    expect(rendered.text).toContain("7 days");
    expect(rendered.text).toContain("confirm your email address to receive updates");
    expect(rendered.html).not.toContain("unsubscribe/token");
    expect(() => renderTemplate(item, {}, brand)).toThrow("Missing template variable: CONFIRM_URL");
  });

  it("assigns only the approved stages to existing templates", () => {
    const previous = library.templates.slice(0, 16);
    expect(previous).toHaveLength(16);
    for (const item of previous) {
      const expected = ["welcome", "invitation"].includes(item.slug) ? "onboarding"
        : ["payment-failed", "trial-ending"].includes(item.slug) ? "dunning" : null;
      expect(item.stage, item.slug).toBe(expected);
      expect(item.when.trim(), item.slug).not.toBe("");
    }
    expect(stages).toEqual(["acquisition", "onboarding", "retention", "reengagement", "dunning", "reactivation"]);
    expect(new Set(library.templates.map((item) => item.slug)).size).toBe(25);
  });

  it.each(["setup-reminder", "confirm-subscription"])("%s renders the canonical default theme CSS", (slug) => {
    const rendered = renderTemplate(entry(slug), { CONFIRM_URL: "https://acme.example/confirm/token" }, brand);
    for (const css of [
      "background-color:#f4f4f5", "background-color:#ffffff", "color:#18181b",
      "border:1px solid #e4e4e7", "font-size:16px", "border-radius:8px",
      "background-color:#18181b;border-radius:8px;border:1px solid #18181b;color:#ffffff",
    ]) {
      expect(rendered.html).toContain(css);
    }
    expect(rendered.html).toContain("font-family:-apple-system");
    expect(rendered.html).not.toContain("{{{");
  });

  it.each(["setup-reminder", "confirm-subscription"])("%s renders nondefault theme CSS and outlined actions", (slug) => {
    const rendered = renderTemplate(entry(slug), { CONFIRM_URL: "https://acme.example/confirm/token" }, {
      ...brand,
      BRAND_COLOR: "#173e70",
      ...themeContext({
        color: "#173e70", text_color: "#152438", background_color: "#eef4fa",
        surface_color: "#ffffff", border_color: "#6f87a0", font_family: emailFonts[2],
        font_size: 18, radius: 13, button_style: "outline",
      }),
    });
    for (const css of [
      "background-color:#eef4fa", "background-color:#ffffff", "color:#152438",
      "border:1px solid #6f87a0", "font-size:18px", "border-radius:13px",
      "background-color:#ffffff;border-radius:13px;border:1px solid #173e70;color:#173e70",
    ]) {
      expect(rendered.html).toContain(css);
    }
    expect(rendered.html).toContain("font-family:Georgia");
    expect(rendered.html).not.toContain("{{{");
  });

  it.each(["setup-reminder", "confirm-subscription"])("%s still rejects a missing reserved theme token", (slug) => {
    const { THEME_FONT_SIZE, ...missingTheme } = brand;
    expect(THEME_FONT_SIZE).toBe("16px");
    expect(missingTheme).not.toHaveProperty("THEME_FONT_SIZE");
    expect(entry(slug).html).toContain("{{{THEME_FONT_SIZE}}}");
    expect(() => renderTemplate(entry(slug), {
      CONFIRM_URL: "https://acme.example/confirm/token",
    }, missingTheme)).toThrow("Missing template variable: THEME_FONT_SIZE");
  });

  it.each(library.templates)("$slug uses declarations accepted by the existing template write contract", (item) => {
    expect(item.variables.some((variable) => reservedVariables.includes(variable.key))).toBe(false);
    expect(templateSchema.safeParse({
      name: item.name, subject: item.subject, html: item.html, text: item.text, variables: item.variables, track: item.track,
    }).success).toBe(true);
  });
});

describe("failing lifecycle quality fixtures", () => {
  it("rejects a required value with neither a fallback nor trigger supply, despite its preview sample", () => {
    const item = entry("setup-reminder");
    item.html = item.html.replaceAll("{{{FIRST_NAME|there}}}", "{{{FIRST_NAME}}}");
    item.text = item.text.replaceAll("{{{FIRST_NAME|there}}}", "{{{FIRST_NAME}}}");
    expect(item.sample.FIRST_NAME).toBe("Ada");
    expect(checkTemplateVariables(item, [])).toEqual([
      "setup-reminder: required variable FIRST_NAME has no fallback or supplied value",
    ]);
    expect(checkTemplateVariables(item, ["FIRST_NAME"])).toEqual([]);
  });

  it("rejects a required payment URL not supplied by an event", () => {
    expect(checkTemplateVariables(entry("card-update-reminder"), ["AMOUNT", "INVOICE_NUMBER"])).toEqual([
      "card-update-reminder: required variable UPDATE_PAYMENT_URL has no fallback or supplied value",
    ]);
  });

  it("accepts empty-string and numeric-zero defaults", () => {
    expect(checkTemplateVariables({
      slug: "defaults",
      subject: "{{{OPTIONAL}}} {{{COUNT}}}",
      html: "",
      text: "",
      variables: [
        { key: "OPTIONAL", type: "string", fallback_value: "" },
        { key: "COUNT", type: "number", fallback_value: 0 },
      ],
    }, [])).toEqual([]);
  });

  it.each(marketing)("%s fails when its unsubscribe link is removed", (slug) => {
    const item = entry(slug);
    item.html = item.html.replaceAll('href="{{{UNSUBSCRIBE_URL}}}"', 'href="{{{PRODUCT_URL}}}"');
    expect(item.text).toContain("{{{UNSUBSCRIBE_URL}}}");
    expect(checkLibrary({ templates: [item] }, themePairs)).toContain(`${slug} check 16: missing UNSUBSCRIBE_URL link`);
  });

  it.each(marketing)("%s fails when its company address is missing", (slug) => {
    const item = entry(slug);
    item.html = item.html.replaceAll("{{{COMPANY_ADDRESS}}}", "");
    expect(checkLibrary({ templates: [item] }, themePairs)).toContain(`${slug} check 16: missing visible COMPANY_ADDRESS`);
  });

  it("requires the unsubscribe link and address in plain text too", () => {
    const item = entry("newsletter-welcome");
    item.text = item.text.replaceAll("{{{COMPANY_ADDRESS}}}", "").replaceAll("{{{UNSUBSCRIBE_URL}}}", "");
    const failures = checkLibrary({ templates: [item] }, themePairs);
    expect(failures).toContain("newsletter-welcome check 16: text is missing UNSUBSCRIBE_URL");
    expect(failures).toContain("newsletter-welcome check 16: text is missing COMPANY_ADDRESS");
  });

  it("rejects missing and invalid stage/when/kind metadata", () => {
    const item = entry("setup-reminder");
    expect(checkLibrary({ templates: [{ ...item, stage: undefined, when: "", kind: "unknown" }] }, themePairs)).toEqual(
      expect.arrayContaining([
        "setup-reminder check 17: invalid or missing stage",
        "setup-reminder check 17: missing when guidance",
        "setup-reminder check 17: invalid kind",
      ]),
    );
    expect(checkLibrary({ templates: [{ ...item, stage: "unknown" }] }, themePairs)).toContain(
      "setup-reminder check 17: invalid or missing stage",
    );
  });

  it("keeps subscription confirmation out of tracking", () => {
    const item = entry("confirm-subscription");
    item.track = true;
    expect(checkLibrary({ templates: [item] }, themePairs)).toContain(
      "confirm-subscription check 15: an authentication template must set track to false",
    );
  });
});
