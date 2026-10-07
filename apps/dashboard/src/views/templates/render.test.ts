import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { blockProblem, brandValues, builtIn, contactField, declarable, fill, hasUnsubscribe, links, noFallback, normalizeVariables, sampleContact, scan } from "./render";

describe("fill", () => {
  it("uses values, then inline fallbacks, then declared fallbacks, and escapes HTML only", () => {
    const out = fill(
      { subject: "Hi {{{NAME}}}", html: "<p>{{{NAME}}} {{{PLAN|free}}} {{{TEAM}}}</p>", text: "{{name}}" },
      { NAME: "<Ada>", name: "ada" },
      [{ key: "TEAM", type: "string", fallback_value: "Acme" }],
    );
    expect(out.subject).toBe("Hi <Ada>");
    expect(out.html).toBe("<p>&lt;Ada&gt; free Acme</p>");
    expect(out.text).toBe("ada");
    expect(out.missing).toEqual([]);
  });

  it("leaves a placeholder with no value visible and reports it", () => {
    const out = fill({ html: "<a href='{{{ACTION_URL}}}'>Go</a>" }, {});
    expect(out.html).toBe("<a href='{{{ACTION_URL}}}'>Go</a>");
    expect(out.missing).toEqual(["ACTION_URL"]);
  });

  it("reads dotted contact paths", () => {
    expect(fill({ html: "Hi {{{contact.first_name|there}}}" }, { contact: { first_name: "Ada" } }).html).toBe("Hi Ada");
    expect(fill({ html: "Hi {{{contact.first_name|there}}}" }, {}).html).toBe("Hi there");
  });

  it("renders #if and #each blocks, with item fields shadowing", () => {
    const html = "{{{#if CODE}}}<b>{{{CODE}}}</b>{{{/if}}}<ul>{{{#each ITEMS}}}<li>{{{description}}}: {{{amount}}}</li>{{{/each}}}</ul>";
    const out = fill({ html }, { ITEMS: [{ description: "Pro", amount: "$9" }, { description: "Seat", amount: "$3" }] });
    expect(out.html).toBe("<ul><li>Pro: $9</li><li>Seat: $3</li></ul>");
    expect(out.missing).toEqual([]);
    expect(fill({ html }, { CODE: "123", ITEMS: [] }).html).toBe("<b>123</b><ul></ul>");
  });
});

type Rendering = { subject?: string; html?: string; text?: string };
type Core = {
  brandContext: (brand: Record<string, unknown>, fallback: Record<string, unknown>) => Record<string, unknown>;
  renderTemplate: (
    fields: Rendering & { variables?: unknown },
    values: Record<string, unknown>,
    context?: Record<string, unknown>,
    options?: { blank?: (key: string) => boolean },
  ) => Rendering;
};

// Core is loaded by path at run time. A static import would pull its source into this package's
// type check, and it cannot be a dependency of browser code.
const core = (await import(/* @vite-ignore */ new URL("../../../../../packages/core/src/index.ts", import.meta.url).href)) as Core;

describe("the same output as the server", () => {
  const { brandContext } = core;
  const server = (fields: Rendering & { variables?: unknown }, values: Record<string, unknown>, context = {}) => core.renderTemplate(fields, values, context);

  it("renders every library template exactly as the API does", () => {
    const library = JSON.parse(readFileSync(new URL("../../../../../packages/templates/library.json", import.meta.url), "utf8")) as {
      templates: Array<{ slug: string; subject: string; html: string; text: string; variables: never[]; sample: Record<string, unknown> }>;
    };
    expect(library.templates.length).toBe(25);
    for (const logo of ["", "https://acme.example/logo.png"]) {
      const context = {
        ...sampleContact,
        ...brandContext({ product_name: "Acme", logo_url: logo, company_address: "1 Main St" }, { tenantName: "Acme", domain: "acme.example", from: "support@acme.example", year: 2026 }),
      };
      for (const entry of library.templates) {
        const expected = server(entry, entry.sample, context);
        const got = fill(entry, { ...context, ...entry.sample }, normalizeVariables(entry.variables));
        expect(got.problem, entry.slug).toBeNull();
        expect(got.missing, entry.slug).toEqual([]);
        expect(got.subject, entry.slug).toBe(expected.subject);
        expect(got.html, entry.slug).toBe(expected.html);
        expect(got.text, entry.slug).toBe(expected.text);
      }
    }
  });

  it("handles #unless, nested blocks of one kind, and empty list fields the same way", () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ["{{{#unless URL}}}none{{{/unless}}}{{{#if URL}}}{{{URL}}}{{{/if}}}", { URL: "" }],
      ["{{{#unless URL}}}none{{{/unless}}}{{{#if URL}}}{{{URL}}}{{{/if}}}", { URL: "https://x.example" }],
      ["{{{#if A}}}a{{{#if B}}}b{{{/if}}}c{{{/if}}}", { A: "1", B: "" }],
      ["{{{#if A}}}a{{{#if B}}}b{{{/if}}}c{{{/if}}}", { A: "1", B: "1" }],
      ["{{{#each ROWS}}}[{{{name}}}|{{{NOTE}}}]{{{/each}}}", { ROWS: [{ name: "" }, { name: "x", NOTE: "" }], NOTE: "outer", name: "outer" }],
      ["{{{#each ROWS}}}{{{#if paid}}}paid{{{/if}}}{{{#unless paid}}}due{{{/unless}}};{{{/each}}}", { ROWS: [{ paid: "yes" }, { paid: "" }] }],
    ];
    for (const [html, values] of cases) {
      expect(fill({ html }, values).html, html).toBe(server({ html }, values).html);
    }
  });

  it("prints a blank for a contact field the contact lacks, in a broadcast", () => {
    const fields = { subject: "Hi {{{contact.first_name}}}", html: "<p>Hi {{{FIRST_NAME}}}{{{#if contact.last_name}}} {{{contact.last_name}}}{{{/if}}}, {{{contact.plan}}}</p>" };
    const values = { contact: { email: "ada@example.com" } };
    const expected = core.renderTemplate(fields, {}, values, { blank: contactField });
    const got = fill(fields, values, [], { blank: contactField });
    expect(got.missing).toEqual([]);
    expect(got.subject).toBe(expected.subject);
    expect(got.html).toBe(expected.html);
    expect(got.html).toBe("<p>Hi , </p>");
    // Outside a broadcast the placeholder stays visible and is reported.
    expect(fill(fields, values).missing).toEqual(["contact.first_name", "FIRST_NAME", "contact.plan"]);
  });

  it("agrees with the server on blanks inside blocks, lists, fallbacks, and plain text", () => {
    const fields = {
      subject: "{{{contact.first_name|Friend}}}, {{{contact.plan}}}",
      html: [
        "{{{#unless contact.first_name}}}<p>Hello there {{{contact.city}}}</p>{{{/unless}}}",
        "{{{#each ITEMS}}}<li>{{{name}}} for {{{contact.first_name}}}</li>{{{/each}}}",
        "<p>{{{LAST_NAME|}}}{{{contact.last_name|Smith}}} {{{EMAIL}}}</p>",
      ].join(""),
      text: "Hi {{{FIRST_NAME}}} {{{contact.plan|free}}}",
    };
    const values = { ITEMS: [{ name: "Book" }, { name: "Pen" }] };
    for (const contact of [{ email: "ada@example.com" }, { email: "ada@example.com", first_name: "Ada", last_name: "Lovelace", plan: "pro", city: "London" }]) {
      const context = { contact, EMAIL: contact.email, FIRST_NAME: (contact as { first_name?: string }).first_name, LAST_NAME: (contact as { last_name?: string }).last_name };
      const expected = core.renderTemplate(fields, values, context, { blank: contactField });
      const got = fill(fields, { ...values, ...context }, [], { blank: contactField });
      expect(got.missing).toEqual([]);
      expect([got.subject, got.html, got.text]).toEqual([expected.subject, expected.html, expected.text]);
    }
  });

  it("reports blocks that do not pair up and leaves the source as written", () => {
    const out = fill({ html: "{{{#if A}}}a" }, { A: "1" });
    expect(out.problem).toBe("{{{#if A}}} is never closed");
    expect(out.html).toBe("{{{#if A}}}a");
    expect(blockProblem("ok", "{{{/each}}}")).toBe("{{{/each}}} has no opening block");
    expect(blockProblem("{{{#if A}}}{{{/if}}}")).toBeNull();
    // Half-typed blocks still list their variables.
    expect(scan("{{{#each ITEMS}}}{{{NAME}}}").map((item) => item.key)).toEqual(["ITEMS", "NAME"]);
  });
});

describe("scan", () => {
  it("knows which names the API accepts as variables", () => {
    expect(declarable("FIRST_NAME2")).toBe(true);
    expect(declarable("first-name")).toBe(false);
    expect(declarable("constructor")).toBe(false);
    expect(declarable("A".repeat(51))).toBe(false);
  });

  it("finds placeholders and block keys in order, skipping list item fields", () => {
    const found = scan("Hi {{{NAME}}}", "{{{#if CODE}}}{{{CODE}}}{{{/if}}}{{{#each ITEMS}}}{{{description}}}{{{/each}}}{{{PLAN|free}}}");
    expect(found).toEqual([
      { key: "NAME", type: "string", inline: false },
      { key: "CODE", type: "string", inline: false },
      { key: "ITEMS", type: "list", inline: false },
      { key: "PLAN", type: "string", inline: true },
    ]);
  });

  it("marks reserved and dotted names as built in", () => {
    expect(builtIn("PRODUCT_NAME")).toBe(true);
    expect(builtIn("contact.first_name")).toBe(true);
    expect(builtIn("ACTION_URL")).toBe(false);
  });
});

describe("helpers", () => {
  it("normalizes string and object variables", () => {
    expect(normalizeVariables(["NAME", { key: "COUNT", type: "number", fallback_value: 1 }])).toEqual([
      { key: "NAME", type: "string", fallback_value: null },
      { key: "COUNT", type: "number", fallback_value: 1 },
    ]);
  });

  it("spots a name printed with no fallback", () => {
    expect(noFallback(["contact.first_name"], "Hi {{{contact.first_name}}}")).toBe(true);
    expect(noFallback(["contact.first_name"], "Hi {{contact.first_name}}")).toBe(true);
    expect(noFallback(["contact.first_name"], "Hi {{{contact.first_name|there}}}", null, "{{{contact.last_name}}}")).toBe(false);
    expect(noFallback(["contact.first_name", "FIRST_NAME"], "Hi {{{contact.first_name|there}}}", "Hi {{{FIRST_NAME}}}")).toBe(true);
  });

  it("collects checkable links and spots the unsubscribe placeholder", () => {
    const html = `<a href="https://a.example/x?a=1&amp;b=2">A</a><a href='mailto:x@y.z'>m</a><a href="{{{DISPATCH_UNSUBSCRIBE_URL}}}">u</a><a href="https://a.example/x?a=1&amp;b=2">again</a>`;
    expect(links(html)).toEqual(["https://a.example/x?a=1&b=2"]);
    expect(hasUnsubscribe(html)).toBe(true);
    expect(hasUnsubscribe("<p>none</p>")).toBe(false);
  });

  it("maps brand settings to the reserved names", () => {
    const values = brandValues({ product_name: "Acme", color: "#112233", text_color: "#ffffff" });
    expect(values.PRODUCT_NAME).toBe("Acme");
    expect(values.COMPANY_NAME).toBe("Acme");
    expect(values.BRAND_COLOR).toBe("#112233");
    expect(values.LOGO_URL).toBe("");
  });

  it("prefers the resolved values the API sends with the brand", () => {
    const values = brandValues({ product_name: "", variables: { PRODUCT_NAME: "Tenant name", SUPPORT_EMAIL: "support@acme.example" } });
    expect(values).toEqual({ PRODUCT_NAME: "Tenant name", SUPPORT_EMAIL: "support@acme.example" });
  });
});
