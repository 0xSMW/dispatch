import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { Webhook } from "standardwebhooks";
import { describe, expect, it } from "vitest";
import {
  ApiError,
  automationSchema,
  backoffSecs,
  batchEnvelopeSchema,
  batchSchema,
  assertBlocks,
  assertRealProvider,
  blockedWebhookHost,
  devApiKey,
  publicFetch,
  requireUrl,
  seedKey,
  publicLookup,
  blockProblem,
  contactField,
  contactSchema,
  domainSchema,
  formatAddress,
  emailBodySchema,
  emailUpdateSchema,
  formatWebhookPayload,
  inboundSchema,
  keyHash,
  list,
  makeKey,
  normalizeWebhookUrl,
  paginationQuerySchema,
  prepareTracking,
  recipientsSchema,
  classifySesError,
  contentTypeForFilename,
  keySchema,
  parseAddress,
  ProviderError,
  decrypt,
  durationSeconds,
  encrypt,
  encrypted,
  endpointDisabled,
  makeWebhookSecret,
  seal,
  signWebhook,
  unseal,
  brandContext,
  brandTextColor,
  renderTemplate,
  templateSchema,
  templateUpdateSchema,
  sendSchema,
  sign,
  stableHash,
  statusFor,
  toArray,
  verify,
  verifyWebhook,
  webhookDelay,
  webhookDeliveryStatus,
  webhookEventData,
  webhookSchema,
  webhookUrl
} from "./index.js";

const letter = {
  from: "hello@example.com",
  to: "you@example.com",
  subject: "Hello",
  text: "Hi"
};

describe("stableHash", () => {
  it("ignores object key order at every level", () => {
    expect(stableHash({ b: 1, a: { d: 2, c: [3, { z: 1, y: 2 }] } })).toBe(
      stableHash({ a: { c: [3, { y: 2, z: 1 }], d: 2 }, b: 1 })
    );
  });

  it("keeps array order", () => {
    expect(stableHash({ to: ["a@example.com", "b@example.com"] })).not.toBe(
      stableHash({ to: ["b@example.com", "a@example.com"] })
    );
  });
});

describe("webhook signatures", () => {
  const payload = JSON.stringify({ type: "email.sent" });
  const signed = sign(payload, "secret", "evt_test", 123);

  it("accepts the signature it just produced", () => {
    expect(verify(payload, "secret", signed.id, String(signed.timestamp), signed.signature)).toBe(true);
  });

  it("rejects a changed payload, secret, id, timestamp, or signature", () => {
    expect(verify(`${payload} `, "secret", signed.id, "123", signed.signature)).toBe(false);
    expect(verify(payload, "other", signed.id, "123", signed.signature)).toBe(false);
    expect(verify(payload, "secret", "evt_other", "123", signed.signature)).toBe(false);
    expect(verify(payload, "secret", signed.id, "124", signed.signature)).toBe(false);
    expect(verify(payload, "secret", signed.id, "123", "nope")).toBe(false);
  });
});

describe("api keys", () => {
  it("returns a secret and the prefix stored for lookup", () => {
    const key = makeKey();
    expect(key.secret.startsWith("sk_")).toBe(true);
    expect(key.prefix).toBe(key.secret.slice(0, 12));
  });

  it("hashes the same secret and pepper to the same value", () => {
    expect(keyHash("sk_test", "pepper")).toBe(keyHash("sk_test", "pepper"));
    expect(keyHash("sk_test", "pepper")).not.toBe(keyHash("sk_test", "other"));
  });
});

describe("templates", () => {
  it("renders declared variables and variables found in the copy", () => {
    expect(renderTemplate({ subject: "Hello {{name}}", html: "<p>{{ message }}</p>" }, { name: "Ada", message: "Welcome" })).toEqual({
      subject: "Hello Ada",
      html: "<p>Welcome</p>",
      text: undefined
    });
  });

  it("does not require a declared variable that no placeholder uses", () => {
    expect(renderTemplate({ subject: "Hello", text: "Hi", variables: ["plan"] }, {})).toEqual({ subject: "Hello", html: undefined, text: "Hi" });
  });

  it("nests blocks of the same and of different kinds", () => {
    const render = (html: string, variables: Record<string, unknown>) => renderTemplate({ html }, variables).html;
    expect(render("{{{#if A}}}<{{{#each L}}}{{{#if f}}}F{{{/if}}}.{{{/each}}}>{{{/if}}}", { A: "1", L: [{ f: "x" }, { f: "" }] })).toBe("<F..>");
    expect(render("{{{#if A}}}1{{{#if B}}}2{{{/if}}}3{{{/if}}}", { A: "1" })).toBe("13");
    expect(render("{{{#each L}}}{{{name}}}:{{{#each tags}}}x{{{/each}}};{{{/each}}}", { L: [{ name: "a" }] })).toBe("a:;");
  });

  it("renders an unless block when the value is absent", () => {
    const subject = "{{{INVITER}}} invited you to {{{#if ORG}}}{{{ORG}}}{{{/if}}}{{{#unless ORG}}}{{{PRODUCT_NAME}}}{{{/unless}}}";
    const variables = [{ key: "INVITER", fallback_value: "A teammate" }, { key: "ORG", fallback_value: "" }];
    expect(renderTemplate({ subject, variables }, {}, { PRODUCT_NAME: "Acme" }).subject).toBe("A teammate invited you to Acme");
    expect(renderTemplate({ subject, variables }, { ORG: "North team" }, { PRODUCT_NAME: "Acme" }).subject).toBe("A teammate invited you to North team");
    expect(() => renderTemplate({ subject: "{{{#unless A}}}x{{{/if}}}" }, {})).toThrow(/closed by/);
  });

  it("rejects blocks that do not balance at render and at publish, and lets a draft hold them", () => {
    expect(() => renderTemplate({ html: "a{{{#if A}}}b" }, {})).toThrow(/never closed/);
    expect(() => renderTemplate({ html: "a{{{/each}}}b" }, {})).toThrow(/no opening block/);
    expect(() => renderTemplate({ html: "{{{#if A}}}{{{#each L}}}{{{/if}}}{{{/each}}}" }, {})).toThrow(/closed by/);
    expect(blockProblem("{{{#if A}}}ok{{{/if}}}")).toBeNull();
    expect(() => assertBlocks({ subject: "Hi", html: "{{{#if A}}}open" })).toThrow("html: Template block {{{#if A}}} is never closed");
    expect(() => assertBlocks({ subject: "{{{/if}}}" })).toThrow(/^subject: /);
    expect(() => assertBlocks({ subject: null, html: "{{{#if A}}}ok{{{/if}}}", text: null })).not.toThrow();
    // An editor saves while a block is half typed.
    expect(templateSchema.safeParse({ name: "T", html: "{{{#if A}}}open" }).success).toBe(true);
    expect(templateUpdateSchema.safeParse({ text: "{{{/if}}}" }).success).toBe(true);
    expect(templateSchema.safeParse({ name: "T", html: "{{{#if A}}}ok{{{/if}}}", track: false }).success).toBe(true);
  });

  it("treats an empty field of a list item as a value and never reads an outer variable in its place", () => {
    const html = "{{{#each ITEMS}}}[{{{description}}}|{{{quantity}}}]{{{/each}}}";
    expect(renderTemplate({ html }, { quantity: "TOP", ITEMS: [{ description: "Discount", quantity: "" }] }).html).toBe("[Discount|]");
    expect(renderTemplate({ html: "{{{#each ITEMS}}}{{{#if note}}}N{{{/if}}}.{{{/each}}}" }, { note: "outer", ITEMS: [{ note: "" }] }).html).toBe(".");
  });

  it("reads own properties only, so prototype names are ordinary missing variables", () => {
    for (const key of ["constructor", "toString", "__proto__"]) {
      expect(() => renderTemplate({ text: `{{{${key}}}}` }, {})).toThrow(`Missing template variable: ${key}`);
    }
    expect(() => renderTemplate({ text: "{{{contact.constructor.name}}}" }, {}, { contact: { first_name: "Ada" } })).toThrow(/Missing template variable/);
    expect(renderTemplate({ text: "{{{#if constructor}}}yes{{{/if}}}no" }, {}).text).toBe("no");
    expect(renderTemplate({ text: "{{{toString}}}" }, { toString: "ok" }).text).toBe("ok");
  });

  it("rejects reserved and prototype names in either variable form", () => {
    expect(templateSchema.safeParse({ name: "T", variables: ["PRODUCT_NAME"] }).success).toBe(false);
    expect(templateSchema.safeParse({ name: "T", variables: [{ key: "PRODUCT_NAME" }] }).success).toBe(false);
    expect(templateSchema.safeParse({ name: "T", variables: ["constructor"] }).success).toBe(false);
    expect(templateSchema.safeParse({ name: "T", variables: ["plan", { key: "COUNT", type: "number" }] }).success).toBe(true);
  });

  it("uses a fallback and triple braces", () => {
    expect(renderTemplate(
      {
        subject: "Hello {{{NAME}}}",
        html: "<p>{{name}}</p>",
        variables: [{ key: "NAME", type: "string", fallback_value: "Ada" }, { key: "name", type: "string", fallback_value: null }]
      },
      { name: "Ada" }
    )).toEqual({ subject: "Hello Ada", html: "<p>Ada</p>", text: undefined });
  });

  it("names the first missing variable", () => {
    try {
      renderTemplate({ subject: "Hello {{name}}" }, { name: null });
      throw new Error("expected a missing variable");
    } catch (error) {
      expect(error).toMatchObject({ name: "validation_error", statusCode: 422, message: "Missing template variable: name" });
    }
  });

  it("uses an inline fallback, a contact path, and a declared number", () => {
    expect(renderTemplate(
      { subject: "Hello {{{NAME|Ada}}}", text: "Count {{count}}" },
      { count: 2 }
    )).toEqual({ subject: "Hello Ada", html: undefined, text: "Count 2" });
    expect(renderTemplate(
      { subject: "Hello {{contact.first_name}}", html: "<p>{{{contact.first_name|there}}}</p>" },
      {},
      { contact: { first_name: "Ada" } }
    ).subject).toBe("Hello Ada");
  });

  it("prints a blank for a missing key that blank accepts, as a broadcast does for contact fields", () => {
    const fields = { subject: "Hi {{{contact.first_name}}}", html: "<p>{{{FIRST_NAME}}}{{{#if contact.last_name}}} {{{contact.last_name}}}{{{/if}}}</p>", text: "{{contact.plan}}" };
    expect(renderTemplate(fields, {}, { contact: { email: "a@example.com" } }, { blank: contactField })).toEqual({ subject: "Hi ", html: "<p></p>", text: "" });
    // A fallback still wins, and any other missing key still fails.
    expect(renderTemplate({ subject: "Hi {{{contact.first_name|there}}}" }, {}, {}, { blank: contactField }).subject).toBe("Hi there");
    expect(() => renderTemplate({ subject: "{{{contact.first_name}}} {{{PROMO}}}" }, {}, {}, { blank: contactField })).toThrow("Missing template variable: PROMO");
    // Without the option, as for a transactional send, a missing contact field fails.
    expect(() => renderTemplate({ subject: "Hi {{{contact.first_name}}}" }, {})).toThrow("Missing template variable: contact.first_name");
    expect(contactField("contact.company")).toBe(true);
    expect(contactField("LAST_NAME")).toBe(true);
    expect(contactField("PRODUCT_NAME")).toBe(false);
  });

  it("rejects a value of the wrong type", () => {
    expect(() => renderTemplate(
      { subject: "Count {{count}}", variables: [{ key: "count", type: "number", fallback_value: null }] },
      { count: "two" }
    )).toThrow(/must be a number/);
  });

  it("skips a hidden block and repeats a list", () => {
    const rendered = renderTemplate({
      subject: "Receipt",
      html: "{{{#if NOTE}}}Note {{NOTE}}{{{/if}}}{{{#each LINE_ITEMS}}}<tr><td>{{description}}</td><td>{{{amount}}}</td></tr>{{{/each}}}",
      variables: [
        { key: "NOTE", type: "string", fallback_value: "" },
        { key: "LINE_ITEMS", type: "list", fallback_value: null }
      ]
    }, {
      LINE_ITEMS: [
        { description: "Plan", amount: "$10" },
        { description: "<b>", amount: "1&2" }
      ]
    });
    expect(rendered.html).toBe("<tr><td>Plan</td><td>$10</td></tr><tr><td>&lt;b&gt;</td><td>1&amp;2</td></tr>");
  });

  it("prints braces that arrive inside a list value", () => {
    const rendered = renderTemplate({
      subject: "Hi",
      text: "{{{#each LINE_ITEMS}}}{{{description}}}{{{/each}}}",
      variables: [{ key: "LINE_ITEMS", type: "list", fallback_value: null }]
    }, { LINE_ITEMS: [{ description: "{{{SECRET}}}" }] });
    expect(rendered.text).toBe("{{{SECRET}}}");
  });

  it("stops a list at 200 items and rejects a value that is not a list", () => {
    const items = Array.from({ length: 201 }, (_, index) => ({ description: String(index) }));
    const rendered = renderTemplate({
      subject: "Hi",
      text: "{{{#each ITEMS}}}{{{description}}},{{{/each}}}",
      variables: [{ key: "ITEMS", type: "list", fallback_value: null }]
    }, { ITEMS: items });
    expect(rendered.text).toBe(Array.from({ length: 200 }, (_, index) => `${index},`).join(""));
    expect(() => renderTemplate({
      subject: "Hi",
      variables: [{ key: "LINE_ITEMS", type: "list", fallback_value: null }]
    }, { LINE_ITEMS: "nope" })).toThrow(/must be a list/);
  });

  it("picks the button label that contrasts with the brand color", () => {
    expect(brandTextColor("#18181b")).toBe("#ffffff");
    expect(brandTextColor("#ffffff")).toBe("#000000");
    expect(brandTextColor("#009000")).toBe("#000000");
    expect(brandContext(
      { color: "#ffffff", product_name: "Acme" },
      { tenantName: "Local", domain: "example.com", from: "hello@example.com", year: 2026 }
    )).toMatchObject({
      PRODUCT_NAME: "Acme",
      PRODUCT_URL: "https://example.com",
      BRAND_COLOR: "#ffffff",
      BRAND_TEXT_COLOR: "#000000",
      SUPPORT_EMAIL: "",
      COMPANY_NAME: "Acme",
      CURRENT_YEAR: "2026"
    });
  });

  it("keeps a react-email source on a template", () => {
    const source = { kind: "react-email", path: "emails/welcome.tsx" };
    expect(templateSchema.parse({ name: "Welcome", subject: "Hi", html: "<p>Hi</p>", source }).source).toEqual(source);
    expect(templateUpdateSchema.parse({ source }).source).toEqual(source);
    expect(() => templateUpdateSchema.parse({ source: { kind: "react-email", extra: true } })).toThrow();
  });

  it("escapes html and leaves the subject alone", () => {
    const rendered = renderTemplate(
      { subject: "Hello {{name}}", html: "<p>{{name}}</p>", text: "{{name}}" },
      { name: `<a href="https://evil.example?a=1&b=2">` }
    );
    expect(rendered.subject).toBe(`Hello <a href="https://evil.example?a=1&b=2">`);
    expect(rendered.text).toBe(`<a href="https://evil.example?a=1&b=2">`);
    expect(rendered.html).toBe("<p>&lt;a href=&quot;https://evil.example?a=1&amp;b=2&quot;&gt;</p>");
  });
});

describe("tracking", () => {
  it("rewrites http links, leaves other hrefs, and inserts the open pixel before body", () => {
    const tracked = prepareTracking(
      `<html><body><a href="https://example.com/docs?q=1">Docs</a><a href="mailto:ada@example.com">Mail</a></body></html>`,
      "http://localhost:3100"
    );

    const click = tracked.tokens.find((token) => token.kind === "click");
    const open = tracked.tokens.find((token) => token.kind === "open");
    expect(click?.url).toBe("https://example.com/docs?q=1");
    expect(tracked.html).toContain(`href="http://localhost:3100/click/${click?.token}"`);
    expect(tracked.html).toContain(`href="mailto:ada@example.com"`);
    expect(tracked.html).toContain(`src="http://localhost:3100/open/${open?.token}.gif"`);
    expect(tracked.html.indexOf("/open/")).toBeLessThan(tracked.html.toLowerCase().indexOf("</body>"));
  });

  it("leaves links and the pixel alone when tracking is off, and does not rewrite an unsubscribe link", () => {
    const html = `<a href="https://example.com/docs">Docs</a><a href="https://app.example/unsubscribe/token">Stop</a>`;
    const off = prepareTracking(html, { baseUrl: "https://links.example", opens: false, clicks: false });
    expect(off.html).toBe(html);
    expect(off.tokens).toEqual([]);
    const clicks = prepareTracking(html, { baseUrl: "https://links.example", opens: false, clicks: true });
    expect(clicks.html).toContain('href="https://app.example/unsubscribe/token"');
    expect(clicks.html).toContain("https://links.example/click/");
    expect(clicks.tokens).toHaveLength(1);
  });

  it("stores the real URL for a link whose href is HTML-escaped", () => {
    const tracked = prepareTracking(
      `<a href="https://pay.example/i?id=1&amp;s=abc&#38;t=2&quot;">Pay</a>`,
      { baseUrl: "https://links.example", clicks: true }
    );
    expect(tracked.tokens[0].url).toBe(`https://pay.example/i?id=1&s=abc&t=2"`);
  });

  it("appends the open pixel when the html has no body tag", () => {
    const tracked = prepareTracking(`<a href='https://example.com/a'>A</a>`, "https://links.example");
    const open = tracked.tokens.find((token) => token.kind === "open");
    expect(tracked.html.endsWith(`<img src="https://links.example/open/${open?.token}.gif" width="1" height="1" alt="" style="display:none" />`)).toBe(
      true
    );
  });
});

describe("webhook hosts", () => {
  const blocked = [
    "localhost",
    "api.localhost",
    "127.0.0.1",
    "10.0.0.1",
    "192.168.0.1",
    "172.16.0.1",
    "172.31.255.1",
    "169.254.169.254",
    "100.64.0.1",
    "100.127.255.1",
    "198.18.0.1",
    "198.19.1.1",
    "0.0.0.0",
    "::1",
    "::",
    "[::1]",
    "fc00::1",
    "fd12::1",
    "fe80::1",
    "::ffff:127.0.0.1",
    "::ffff:10.0.0.1",
    // The URL parser rewrites a mapped address to hex groups.
    "[::ffff:7f00:1]",
    "[::ffff:a9fe:a9fe]",
    "[::7f00:1]",
    "[64:ff9b::7f00:1]",
    "[2002:7f00:1::1]",
    "0.1.2.3",
    "fe90::1",
    "ff02::1",
    "224.0.0.1",
    "localhost."
  ];
  const allowed = ["8.8.8.8", "172.15.0.1", "172.32.0.1", "100.63.0.1", "100.128.0.1", "198.17.0.1", "198.20.0.1", "example.com", "::ffff:8.8.8.8"];

  it.each(blocked)("blocks %s", (host) => {
    expect(blockedWebhookHost(host)).toBe(true);
  });

  it.each(allowed)("allows %s", (host) => {
    expect(blockedWebhookHost(host)).toBe(false);
  });

  it("rejects private targets, non-http urls, and plain http in production", async () => {
    await expect(normalizeWebhookUrl("https://127.0.0.1/hook")).rejects.toThrow("not allowed");
    await expect(normalizeWebhookUrl("ftp://example.com/hook", { allowPrivate: true })).rejects.toThrow("http or https");
    await expect(normalizeWebhookUrl("http://example.com/hook", { requireHttps: true, allowPrivate: true })).rejects.toThrow("https");
    await expect(normalizeWebhookUrl("not a url", { allowPrivate: true })).rejects.toThrow("Invalid webhook URL");
  });

  it("drops the hash and keeps a private host when local targets are allowed", async () => {
    expect(await normalizeWebhookUrl("http://localhost:8787/webhooks#frag", { allowPrivate: true })).toBe("http://localhost:8787/webhooks");
  });
});

describe("production guards", () => {
  it("requires public and app URLs to use HTTPS without credentials in production", () => {
    for (const name of ["PUBLIC_URL", "APP_URL"] as const) {
      for (const value of [undefined, "", "not a URL", "http://example.com", "file:///tmp/app", "https://", "https://user@example.com", "https://user:password@example.com"]) {
        expect(() => requireUrl(name, "http://localhost:3000", { NODE_ENV: "production", [name]: value })).toThrow(name);
      }
      const value = "https://example.com/app";
      expect(requireUrl(name, "http://localhost:3000", { NODE_ENV: "production", [name]: value })).toBe(value);
      expect(requireUrl(name, "http://localhost:3000", {})).toBe("http://localhost:3000");
      expect(requireUrl(name, "http://localhost:3000", { NODE_ENV: "development", [name]: "http://localhost:4000" })).toBe("http://localhost:4000");
    }
  });
  it("refuses the fake provider in production unless it is allowed on purpose", () => {
    expect(() => assertRealProvider({ NODE_ENV: "production" })).toThrow(/SES_PROVIDER/);
    expect(() => assertRealProvider({ NODE_ENV: "production", SES_PROVIDER: "" })).toThrow(/SES_PROVIDER/);
    expect(() => assertRealProvider({ NODE_ENV: "production", SES_PROVIDER: "ses" })).not.toThrow();
    expect(() => assertRealProvider({ NODE_ENV: "production", ALLOW_FAKE_PROVIDER: "true" })).not.toThrow();
    expect(() => assertRealProvider({})).not.toThrow();
  });

  it("will not seed production with the public development key", () => {
    expect(seedKey({})).toBe(devApiKey);
    expect(seedKey({ DISPATCH_API_KEY: "sk_mine" })).toBe("sk_mine");
    expect(() => seedKey({ NODE_ENV: "production" })).toThrow(/DISPATCH_API_KEY/);
    expect(() => seedKey({ NODE_ENV: "production", DISPATCH_API_KEY: devApiKey })).toThrow(/DISPATCH_API_KEY/);
    expect(() => seedKey({ NODE_ENV: "production", DISPATCH_API_KEY: "short" })).toThrow(/32/);
    const key = `sk_${"a".repeat(40)}`;
    expect(seedKey({ NODE_ENV: "production", DISPATCH_API_KEY: key })).toBe(key);
  });
});

describe("custom headers", () => {
  it("rejects case-insensitive routing headers including a crafted Sender", () => {
    for (const name of ["From", "sEnDeR", "To", "Cc", "Bcc", "Reply-To", "Resent-From", "Resent-Sender", "Resent-To", "Resent-Cc", "Resent-Bcc", "Resent-Reply-To", "X-SES-CONFIGURATION-SET"]) {
      expect(sendSchema.safeParse({ ...letter, headers: { [name]: "attacker@example.com" } }).success).toBe(false);
      expect(emailUpdateSchema.safeParse({ headers: { [name]: "attacker@example.com" } }).success).toBe(false);
    }
  });

  it("preserves safe headers and enforces name, value, count, and aggregate limits", () => {
    const accepts = (headers: Record<string, string>) => sendSchema.safeParse({ ...letter, headers }).success;
    expect(accepts({ "X-Request-ID": "request-123", "List-Unsubscribe": "<https://example.com/unsubscribe>" })).toBe(true);
    expect(accepts({ ["X".repeat(78)]: "a".repeat(998) })).toBe(true);
    for (const name of ["", "X Invalid", "X:Invalid", "X\nInvalid", "X".repeat(79)]) expect(accepts({ [name]: "safe" })).toBe(false);
    expect(accepts({ "X-Test": "a".repeat(999) })).toBe(false);
    expect(accepts({ "X-Test": "é".repeat(500) })).toBe(false);
    expect(accepts({ "X-Test": "safe\r\nSender: attacker@example.com" })).toBe(false);
    expect(accepts(Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`X-${i}`, "safe"])))).toBe(true);
    expect(accepts(Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`X-${i}`, "safe"])))).toBe(false);
    expect(accepts(Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`X-${i}`, "a".repeat(998)])))).toBe(false);
  });
});

describe("publicLookup", () => {
  const resolve = (host: string, all: boolean) =>
    new Promise<{ error: NodeJS.ErrnoException | null; address?: unknown }>((done) =>
      publicLookup(host, { all }, (error, address) => done({ error, address })),
    );

  it("refuses a name that resolves to this machine, at the moment of connecting", async () => {
    // localhost resolves without the network, to a loopback address.
    for (const all of [false, true]) {
      const result = await resolve("localhost", all);
      expect(result.error?.code).toBe("EHOSTBLOCKED");
      expect(result.address).toBeUndefined();
    }
  });

  it("passes a lookup failure through", async () => {
    const result = await resolve("no-such-host.invalid", false);
    expect(result.error).toBeTruthy();
    expect(result.error?.code).not.toBe("EHOSTBLOCKED");
  });

  it("makes publicFetch fail for a private target instead of connecting", async () => {
    await expect(publicFetch("http://localhost:9/x", { signal: AbortSignal.timeout(2000) })).rejects.toThrow();
  });
});

describe("parseAddress", () => {
  it("splits a display name from the mailbox", () => {
    expect(parseAddress("Ada Lovelace <ada@example.com>")).toEqual({ email: "ada@example.com", name: "Ada Lovelace" });
    expect(parseAddress("ada@example.com")).toEqual({ email: "ada@example.com", name: null });
    expect(parseAddress('"Acme, Inc" <hello@acme.com>')).toEqual({ email: "hello@acme.com", name: "Acme, Inc" });
  });
});

describe("formatAddress", () => {
  it("leaves a plain name bare, quotes specials, and encodes names outside ASCII", () => {
    expect(formatAddress("ada@example.com")).toBe("ada@example.com");
    expect(formatAddress("ada@example.com", "Ada Lovelace")).toBe("Ada Lovelace <ada@example.com>");
    expect(formatAddress("hello@acme.com", "Acme, Inc")).toBe('"Acme, Inc" <hello@acme.com>');
    expect(formatAddress("hello@acme.com", "Acme (Billing)")).toBe('"Acme (Billing)" <hello@acme.com>');
    expect(formatAddress("jose@example.com", "José")).toBe(`=?UTF-8?B?${Buffer.from("José").toString("base64")}?= <jose@example.com>`);
  });

  it("splits a long encoded name into words of 75 characters or fewer", () => {
    const formatted = formatAddress("team@example.com", "株式会社サンプル・インターナショナル・ホールディングス東京本社営業部");
    const words = formatted.replace(" <team@example.com>", "").split(" ");
    expect(words.length).toBeGreaterThan(1);
    expect(words.every((word) => word.length <= 75)).toBe(true);
    const decoded = words.map((word) => Buffer.from(word.slice(10, -2), "base64").toString("utf8")).join("");
    expect(decoded).toBe("株式会社サンプル・インターナショナル・ホールディングス東京本社営業部");
  });

  it("never lets a line break into a header", () => {
    expect(formatAddress("a@example.com", "Ada\r\nBcc: x@example.com")).toBe('"Ada Bcc: x@example.com" <a@example.com>');
    expect(sendSchema.safeParse({ ...letter, from: "Ada\r\nBcc: x@example.com <a@example.com>" }).success).toBe(false);
  });
});

describe("send schema", () => {
  it("accepts text, html, or a template id or object", () => {
    expect(sendSchema.parse(letter).text).toBe("Hi");
    expect(sendSchema.parse({ ...letter, text: undefined, html: "<p>Hi</p>" }).html).toBe("<p>Hi</p>");
    expect(sendSchema.parse({ from: letter.from, to: letter.to, template: "welcome" }).template).toEqual({
      id: "welcome",
      variables: undefined
    });
    expect(
      sendSchema.parse({
        from: "Ada <ada@example.com>",
        to: letter.to,
        template: { id: "welcome", variables: { name: "Ada" } }
      }).template
    ).toEqual({ id: "welcome", variables: { name: "Ada" } });
  });

  it("keeps sibling variables when the template is given by name or without its own variables", () => {
    const byName = sendSchema.parse({ ...letter, text: undefined, subject: undefined, template: "welcome", variables: { name: "Ada" } });
    expect(byName.template?.variables ?? byName.variables).toEqual({ name: "Ada" });
    const again = sendSchema.parse(JSON.parse(JSON.stringify(byName)));
    expect(again.template?.variables ?? again.variables).toEqual({ name: "Ada" });
    const byObject = sendSchema.parse({ from: letter.from, to: letter.to, template: { id: "welcome" }, variables: { name: "Ada" } });
    expect(byObject.template?.variables ?? byObject.variables).toEqual({ name: "Ada" });
  });

  it("lets a template supply the sender, and requires from without one", () => {
    expect(sendSchema.safeParse({ to: letter.to, template: "welcome" }).success).toBe(true);
    expect(sendSchema.safeParse({ to: letter.to, subject: "Hello", text: "Hi" }).success).toBe(false);
  });

  it("accepts reply_to and a tag array, and rejects html beside a template", () => {
    expect(sendSchema.parse({ ...letter, reply_to: "Ada <ada@example.com>" }).reply_to).toBe("Ada <ada@example.com>");
    expect(sendSchema.parse({ ...letter, tags: [{ name: "category", value: "welcome" }] }).tags).toEqual({
      category: "welcome"
    });
    expect(sendSchema.safeParse({ ...letter, template: "welcome", html: "<p>Hi</p>" }).success).toBe(false);
    expect(sendSchema.safeParse({ ...letter, extra: true }).success).toBe(false);
  });

  it("rejects a letter with no content or no subject", () => {
    expect(sendSchema.safeParse({ from: letter.from, to: letter.to, subject: "Hello" }).success).toBe(false);
    expect(sendSchema.safeParse({ from: letter.from, to: letter.to, text: "Hi" }).success).toBe(false);
  });

  it("caps each recipient field at 50", () => {
    expect(sendSchema.safeParse({ ...letter, to: addresses(50) }).success).toBe(true);
    expect(sendSchema.safeParse({ ...letter, to: addresses(51) }).success).toBe(false);
    expect(sendSchema.safeParse({ ...letter, cc: addresses(51, "cc") }).success).toBe(false);
    expect(sendSchema.safeParse({ ...letter, bcc: addresses(51, "bcc") }).success).toBe(false);
  });

  it("keeps a schedule phrase for the API to parse", () => {
    expect(sendSchema.parse({ ...letter, scheduled_at: "in 1 hour" }).scheduled_at).toBe("in 1 hour");
    expect(sendSchema.parse({ ...letter, scheduled_at: "2026-10-02T00:00:00.000Z" }).scheduled_at).toBe(
      "2026-10-02T00:00:00.000Z"
    );
  });

  it("derives a content type from the filename", () => {
    expect(contentTypeForFilename("note.pdf")).toBe("application/pdf");
    expect(contentTypeForFilename("blob")).toBe("application/octet-stream");
  });
});

describe("batch schema", () => {
  it("accepts a bare array or an emails object, up to 100", () => {
    expect(batchSchema.parse([letter])).toHaveLength(1);
    expect(batchSchema.safeParse({ emails: [letter] }).success).toBe(true);
    expect(batchSchema.safeParse({ emails: addresses(100).map((to) => ({ ...letter, to })) }).success).toBe(true);
    expect(batchSchema.safeParse(addresses(101).map((to) => ({ ...letter, to }))).success).toBe(false);
  });

  it("rejects attachments and allows a per-email schedule", () => {
    expect(
      batchSchema.safeParse({
        emails: [{ ...letter, attachments: [{ filename: "a.txt", content: "YQ==" }] }]
      }).success
    ).toBe(false);
    expect(batchSchema.parse([{ ...letter, scheduled_at: "2026-10-02T00:00:00.000Z" }])[0].scheduled_at).toBe(
      "2026-10-02T00:00:00.000Z"
    );
  });
});

describe("batch envelope schema", () => {
  it("checks the list shape and leaves each email for per-item validation", () => {
    expect(batchEnvelopeSchema.parse([{ to: "not-an-email" }, letter])).toHaveLength(2);
    expect(batchEnvelopeSchema.parse({ emails: [letter] })).toEqual([letter]);
    expect(batchEnvelopeSchema.safeParse([]).success).toBe(false);
    expect(batchEnvelopeSchema.safeParse(["nope"]).success).toBe(false);
    expect(batchEnvelopeSchema.safeParse(addresses(101).map((to) => ({ ...letter, to }))).success).toBe(false);
  });
});

describe("domain schema", () => {
  it("lowercases the name and rejects anything that is not a hostname", () => {
    expect(domainSchema.parse({ name: " Mail.Acme.COM " }).name).toBe("mail.acme.com");
    expect(domainSchema.safeParse({ name: "acme" }).success).toBe(false);
    expect(domainSchema.safeParse({ name: "acme .com" }).success).toBe(false);
    expect(domainSchema.safeParse({ name: "https://acme.com" }).success).toBe(false);
  });
});

describe("contact schema", () => {
  it("leaves properties and unsubscribed unset so a repeat create cannot overwrite them", () => {
    const parsed = contactSchema.parse({ email: "ada@example.com" });
    expect(parsed.properties).toBeUndefined();
    expect(parsed.unsubscribed).toBeUndefined();
  });
});

describe("api key schema", () => {
  it("accepts permission or scope and stores a domain only on a sending key", () => {
    expect(keySchema.parse({ name: "app", permission: "sending_access", domain_id: "dom_1" })).toMatchObject({
      permission: "sending_access",
      scope: "send",
      domain_id: "dom_1"
    });
    expect(keySchema.parse({ name: "app", scope: "full" }).permission).toBe("full_access");
    expect(keySchema.safeParse({ name: "app", permission: "full_access", domain_id: "dom_1" }).success).toBe(false);
    expect(keySchema.safeParse({ name: "x".repeat(51) }).success).toBe(false);
  });
});

describe("automation schema", () => {
  it("accepts the five step types and rejects an empty flow", () => {
    expect(
      automationSchema.parse({
        name: "Welcome",
        trigger: "user.signed_up",
        steps: [
          { type: "update_contact", properties: { source: "automation" } },
          { type: "add_to_segment", segment_id: "seg_1" },
          { type: "delay", seconds: 60 },
          { type: "wait", event: "user.activated" },
          { type: "send_email", from: "hello@example.com", template: "welcome" }
        ]
      }).steps
    ).toHaveLength(6);
    expect(automationSchema.safeParse({ name: "Empty", trigger: "user.signed_up", steps: [] }).success).toBe(false);
  });

  it("rejects a delay outside 1 second to 30 days", () => {
    const flow = (seconds: number) => ({ name: "Delay", trigger: "user.delayed", steps: [{ type: "delay", seconds }] });
    expect(automationSchema.safeParse(flow(0)).success).toBe(false);
    expect(automationSchema.safeParse(flow(2_592_001)).success).toBe(false);
    expect(automationSchema.safeParse(flow(2_592_000)).success).toBe(true);
  });
});

describe("inbound schema", () => {
  it("requires a subject and html or text", () => {
    expect(inboundSchema.parse({ from: letter.from, to: letter.to, subject: "Inbound", text: "Hi" }).subject).toBe("Inbound");
    expect(inboundSchema.safeParse({ from: letter.from, to: letter.to, subject: "Inbound" }).success).toBe(false);
    expect(inboundSchema.safeParse({ from: letter.from, to: letter.to, text: "Hi" }).success).toBe(false);
  });
});

describe("lists", () => {
  it("wraps rows in the list envelope", () => {
    expect(list([{ id: "email_1" }], true)).toEqual({ object: "list", has_more: true, data: [{ id: "email_1" }] });
  });

  it("turns one address, many addresses, or none into an array", () => {
    expect(toArray()).toEqual([]);
    expect(toArray("ada@example.com")).toEqual(["ada@example.com"]);
    expect(toArray(["ada@example.com", "grace@example.com"])).toEqual(["ada@example.com", "grace@example.com"]);
  });
});

describe("statusFor", () => {
  it("maps event types to email status", () => {
    expect(statusFor("email.sent")).toBe("sent");
    expect(statusFor("email.delivered")).toBe("delivered");
    expect(statusFor("email.delivery_delayed")).toBe("delivery_delayed");
    expect(statusFor("email.bounced")).toBe("bounced");
    expect(statusFor("email.complained")).toBe("complained");
    expect(statusFor("email.failed")).toBe("failed");
    expect(statusFor("email.opened")).toBe("opened");
    expect(statusFor("email.clicked")).toBe("clicked");
    expect(statusFor("email.suppressed")).toBe("suppressed");
    expect(statusFor("email.scheduled")).toBe("queued");
    expect(statusFor("email.received")).toBe("queued");
  });
});

describe("webhookUrl", () => {
  it("strips hash fragment from url", () => {
    expect(webhookUrl("https://example.com/webhook#frag")).toBe("https://example.com/webhook");
    expect(webhookUrl("https://example.com/webhook")).toBe("https://example.com/webhook");
  });
});

describe("backoffSecs", () => {
  it("calculates exponential backoff with max cap", () => {
    expect(backoffSecs(0)).toBe(1);
    expect(backoffSecs(1)).toBe(2);
    expect(backoffSecs(2)).toBe(4);
    expect(backoffSecs(5)).toBe(32);
    expect(backoffSecs(10)).toBe(300);
    expect(backoffSecs(10, 60)).toBe(60);
  });
});

describe("formatWebhookPayload", () => {
  it("formats standard webhook payload", () => {
    const payload = formatWebhookPayload({
      id: "evt_123",
      request_id: "req_456",
      type: "email.delivered",
      email_id: "email_789",
      data: { recipient: "a@b.com" },
      created_at: "2026-10-01T00:00:00.000Z"
    });
    expect(payload).toEqual({
      id: "evt_123",
      request_id: "req_456",
      type: "email.delivered",
      email_id: "email_789",
      data: { recipient: "a@b.com" },
      created_at: "2026-10-01T00:00:00.000Z"
    });
  });

  it("defaults created_at if omitted", () => {
    const payload = formatWebhookPayload({
      id: "evt_123",
      request_id: null,
      type: "email.sent",
      email_id: null,
      data: {}
    });
    expect(payload.id).toBe("evt_123");
    expect(typeof payload.created_at).toBe("string");
  });
});

describe("paginationQuerySchema", () => {
  it("parses defaults and coerced limit", () => {
    expect(paginationQuerySchema.parse({})).toEqual({ limit: 20 });
    expect(paginationQuerySchema.parse({ limit: "50" })).toEqual({ limit: 50 });
  });

  it("accepts resource id cursors", () => {
    const parsed = paginationQuerySchema.parse({
      limit: 10,
      after: "email_abc"
    });
    expect(parsed.limit).toBe(10);
    expect(parsed.after).toBe("email_abc");
  });
});

describe("durationSeconds", () => {
  it("parses the units automations and share links both use", () => {
    expect(durationSeconds("10m")).toBe(600);
    expect(durationSeconds("2 hours")).toBe(7_200);
    expect(durationSeconds("1 day")).toBe(86_400);
    expect(durationSeconds("1 week")).toBe(604_800);
    expect(durationSeconds("30 secs")).toBe(30);
    expect(durationSeconds("5 mins")).toBe(300);
    expect(() => durationSeconds("soon")).toThrow(/Invalid duration/);
    expect(() => durationSeconds("10ms")).toThrow(/Invalid duration/);
  });
});

describe("seal", () => {
  it("round-trips a payload and rejects a bad signature or an expired token", () => {
    const token = seal({ use: "file", key: "raw/tenant_1/recv_1", exp: Math.floor(Date.now() / 1000) + 60 }, "secret");
    expect(unseal(token, "secret")).toMatchObject({ use: "file", key: "raw/tenant_1/recv_1" });
    expect(unseal(token, "other")).toBeNull();
    expect(unseal(`${token}x`, "secret")).toBeNull();
    const expired = seal({ use: "file", exp: Math.floor(Date.now() / 1000) - 10 }, "secret");
    expect(unseal(expired, "secret")).toBeNull();
  });
});

describe("classifySesError", () => {
  it("treats rejection as permanent and throttling or a network failure as retryable", () => {
    expect(classifySesError({ name: "MessageRejected" })).toMatchObject({ name: "ProviderError", reason: "MessageRejected", retryable: false });
    expect(classifySesError({ name: "MailFromDomainNotVerifiedException" }).retryable).toBe(false);
    expect(classifySesError({ name: "AccountSuspendedException" }).retryable).toBe(false);
    expect(classifySesError({ name: "TooManyRequestsException" }).retryable).toBe(true);
    expect(classifySesError({ name: "ServiceException", $metadata: { httpStatusCode: 503 } }).retryable).toBe(true);
    expect(classifySesError({ message: "socket hang up" })).toMatchObject({ retryable: true, reason: "socket hang up" });
    expect(classifySesError({ name: "MessageRejected" })).toBeInstanceOf(ProviderError);
  });
});

describe("standard webhooks", () => {
  it("verifies with the standardwebhooks library and rejects a stale timestamp", () => {
    const secret = makeWebhookSecret();
    const payload = JSON.stringify({ type: "email.sent", data: { email_id: "email_1" } });
    const signed = signWebhook(payload, [secret, makeWebhookSecret()], "msg_1");
    const headers = {
      "webhook-id": signed.id,
      "webhook-timestamp": String(signed.timestamp),
      "webhook-signature": signed.signature
    };
    expect(new Webhook(secret).verify(payload, headers)).toEqual({ type: "email.sent", data: { email_id: "email_1" } });
    expect(verifyWebhook(payload, secret, { id: signed.id, timestamp: headers["webhook-timestamp"], signature: signed.signature })).toBe(true);
    expect(verifyWebhook(payload, secret, { id: signed.id, timestamp: String(signed.timestamp - 301), signature: signed.signature })).toBe(false);
    expect(verifyWebhook(`${payload}x`, secret, { id: signed.id, timestamp: headers["webhook-timestamp"], signature: signed.signature })).toBe(false);
  });

  it("accepts endpoint or url, status or enabled, and events all", () => {
    expect(webhookSchema.parse({ endpoint: "https://example.com/hook", status: "disabled", events: ["all"] })).toMatchObject({
      endpoint: "https://example.com/hook",
      enabled: false,
      events: expect.arrayContaining(["email.sent", "domain.updated", "contact.created"])
    });
    expect(webhookSchema.parse({ url: "https://example.com/hook" }).endpoint).toBe("https://example.com/hook");
  });

  it("retries on Resend's schedule and stops after the last attempt", () => {
    expect(webhookDelay(1)).toBe(5);
    expect(webhookDelay(2)).toBe(300);
    expect(webhookDelay(7)).toBe(36_000);
    expect(webhookDelay(8)).toBeNull();
    expect(webhookDelay(4, 5)).toBe(7_200);
    expect(webhookDelay(5, 5)).toBeNull();
  });

  it("keeps the full schedule when WEBHOOK_MAX_ATTEMPTS is empty or not a positive whole number", () => {
    const before = process.env.WEBHOOK_MAX_ATTEMPTS;
    try {
      for (const value of ["", "abc", "0", "-2", "1.5"]) {
        process.env.WEBHOOK_MAX_ATTEMPTS = value;
        expect(webhookDelay(1)).toBe(5);
      }
      process.env.WEBHOOK_MAX_ATTEMPTS = "3";
      expect(webhookDelay(2)).toBe(300);
      expect(webhookDelay(3)).toBeNull();
    } finally {
      if (before === undefined) delete process.env.WEBHOOK_MAX_ATTEMPTS;
      else process.env.WEBHOOK_MAX_ATTEMPTS = before;
    }
  });

  it("maps a delivery attempt to a status and builds the email payload", () => {
    expect(webhookDeliveryStatus({ state: "sent", attempt: 1 })).toBe("success");
    expect(webhookDeliveryStatus({ state: "queued", attempt: 1 })).toBe("pending");
    expect(webhookDeliveryStatus({ state: "queued", attempt: 2 })).toBe("attempting");
    expect(webhookDeliveryStatus({ state: "failed", attempt: 3 })).toBe("failed");
    expect(webhookEventData({
      email_id: "email_1",
      email_created_at: "2026-10-01T00:00:00.000Z",
      from_name: "Ada",
      from_email: "ada@example.com",
      to: ["you@example.com"],
      subject: "Hello",
      message_id: "<abc>",
      tags: { kind: "receipt" },
      broadcast_id: null,
      template_id: "tmpl_1",
      data: { bounce: { type: "Permanent", subType: "General", message: "550" } }
    })).toMatchObject({
      email_id: "email_1",
      from: "Ada <ada@example.com>",
      template_id: "tmpl_1",
      bounce: { type: "Permanent" }
    });
  });

  it("encrypts a webhook secret and leaves a legacy plaintext value alone", () => {
    const stored = encrypt("whsec_abc", "app-secret");
    expect(stored.startsWith("enc:v2:")).toBe(true);
    expect(encrypted(stored)).toBe(true);
    expect(decrypt(stored, "app-secret")).toBe("whsec_abc");
    expect(decrypt("whsec_legacy", "app-secret")).toBe("whsec_legacy");
    expect(encrypted("whsec_legacy")).toBe(false);
    expect(() => decrypt(stored, "another-secret")).toThrow();

    // A value written before the key was derived: a plain hash of the secret. Still readable.
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", createHash("sha256").update("app-secret").digest(), iv);
    const body = Buffer.concat([cipher.update("whsec_old", "utf8"), cipher.final()]);
    const old = `enc:v1:${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${body.toString("base64url")}`;
    expect(encrypted(old)).toBe(true);
    expect(decrypt(old, "app-secret")).toBe("whsec_old");
    // The encryption key is not the key that signs tokens: a token signature made with the
    // secret says nothing about the derived key, and the v1 key no longer opens new values.
    const [nextIv, tag, text] = stored.slice("enc:v2:".length).split(".");
    const decipher = createDecipheriv("aes-256-gcm", createHash("sha256").update("app-secret").digest(), Buffer.from(nextIv!, "base64url"));
    decipher.setAuthTag(Buffer.from(tag!, "base64url"));
    expect(() => Buffer.concat([decipher.update(Buffer.from(text!, "base64url")), decipher.final()])).toThrow();
    const since = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000).toISOString();
    expect(endpointDisabled(since)).toBe(true);
    expect(endpointDisabled(new Date().toISOString())).toBe(false);
  });
});

describe("composed email schemas", () => {
  it("validates recipientsSchema single or array", () => {
    expect(recipientsSchema.parse("test@example.com")).toBe("test@example.com");
    expect(recipientsSchema.parse(["test@example.com"])).toEqual(["test@example.com"]);
  });

  it("validates emailBodySchema", () => {
    const body = emailBodySchema.parse({ subject: "Hi", html: "<p>Yo</p>" });
    expect(body.subject).toBe("Hi");
    expect(body.html).toBe("<p>Yo</p>");
  });
});

function addresses(count: number, prefix = "user") {
  return Array.from({ length: count }, (_, index) => `${prefix}-${index}@example.com`);
}
