import { makeKey, makeWebhookSecret } from "@dispatchmail/core";
import { describe, expect, it } from "vitest";
import { hideLinks, hostOnly, jsonbParams, logBodies, logWhere, presentLog, redact, responseText } from "./logs.js";

describe("log bodies", () => {
  it("stores an api key and a webhook without their secrets", () => {
    const key = makeKey();
    const signingSecret = makeWebhookSecret();
    const keyBodies = logBodies({
      method: "POST",
      route: "/api-keys",
      body: { name: "ci" },
      responseText: JSON.stringify({
        id: "key_1",
        object: "api_key",
        token: key.secret,
        request_id: "req_key",
      }),
    });
    const hookBodies = logBodies({
      method: "POST",
      route: "/webhooks",
      body: { endpoint: "https://hooks.example/dispatch", events: ["email.sent"] },
      responseText: JSON.stringify({
        object: "webhook",
        id: "wh_1",
        endpoint: "https://hooks.example/dispatch",
        status: "enabled",
        signing_secret: signingSecret,
        events: ["email.sent"],
      }),
    });
    const stored = jsonbParams([
      keyBodies.request_body,
      keyBodies.response_body,
      hookBodies.request_body,
      hookBodies.response_body,
    ]).join("\n");

    expect(stored).not.toContain(key.secret);
    expect(stored).not.toContain(signingSecret);
    expect(keyBodies.response_body).toMatchObject({ token: "[redacted]", object: "api_key" });
    expect(hookBodies.response_body).toMatchObject({ signing_secret: "[redacted]" });
    expect(hookBodies.request_body).toMatchObject({ endpoint: "https://hooks.example/dispatch" });
  });

  it("drops list responses and shortens long attachment content", () => {
    const content = "a".repeat(300);
    const list = logBodies({
      method: "GET",
      route: "/logs",
      body: undefined,
      responseText: JSON.stringify({ object: "list", data: [{ token: "sk_should_not_stick" }] }),
    });
    const detailList = logBodies({
      method: "GET",
      route: "/emails/:id/events",
      body: undefined,
      responseText: JSON.stringify({ object: "list", data: [] }),
    });
    const send = logBodies({
      method: "POST",
      route: "/emails",
      body: { html: "<p>Hi</p>", attachments: [{ filename: "a.txt", content }] },
      responseText: JSON.stringify({ id: "email_1", object: "email" }),
    });

    expect(list).toEqual({ request_body: null, response_body: null });
    expect(detailList).toEqual({ request_body: null, response_body: null });
    expect(JSON.stringify(send.request_body)).not.toContain(content);
    expect(send.request_body).toMatchObject({
      attachments: [{ content: "[300 bytes]" }],
    });
    expect(send.response_body).toMatchObject({ id: "email_1" });
  });

  it("keeps a detail response and refuses a response over the limit", () => {
    const detail = logBodies({
      method: "GET",
      route: "/logs/:id",
      body: undefined,
      responseText: JSON.stringify({ object: "log", id: "log_1", response_status: 201 }),
    });
    expect(detail.response_body).toMatchObject({ id: "log_1" });
    expect(responseText("x".repeat(64 * 1024 + 1))).toBeNull();
    expect(redact({ nested: { password: "hunter2", name: "ada" } })).toEqual({
      nested: { password: "[redacted]", name: "ada" },
    });
  });
});

describe("log filters and presenter", () => {
  it("filters by status class, user agent, api key, and dates", () => {
    const filters = logWhere({
      path: "/emails",
      status: "4xx",
      user_agent: "resend-node",
      api_key_id: "key_1",
      start_date: "2026-07-01T00:00:00.000Z",
      end_date: "2026-07-08T00:00:00.000Z",
    });
    expect(filters.where).toBe(
      "path like '%' || $2 || '%' and user_agent like '%' || $3 || '%' and api_key_id = $4 and status >= $5 and status < $5 + 100 and created_at >= $6 and created_at <= $7",
    );
    expect(filters.params).toEqual([
      "/emails",
      "resend-node",
      "key_1",
      400,
      "2026-07-01T00:00:00.000Z",
      "2026-07-08T00:00:00.000Z",
    ]);
    expect(logWhere({ status: "201" }).where).toBe("status = $2");
    expect(logWhere({ q: "log_1" })).toEqual({
      where: "(id = $2 or request_id = $2 or path like '%' || $2 || '%')",
      params: ["log_1"],
    });
    const forEmail = logWhere({ email_id: "email_1", status: "200" });
    expect(forEmail.where).toBe(
      "(request_id = (select request_id from emails where tenant_id = $1 and id = $2) or path like '%/emails/' || $2 || '%') and status = $3",
    );
    expect(forEmail.params).toEqual(["email_1", 200]);
    expect(() => logWhere({ status: "nope" })).toThrow(/status must be a code/);
  });

  it("renames the list row and adds bodies on the detail", () => {
    const row = {
      id: "log_1",
      created_at: "2026-10-01T00:00:00.000Z",
      path: "/api-keys",
      method: "POST",
      status: 200,
      user_agent: "dispatch-node/0.1.0",
      request_body: { name: "ci" },
      response_body: { token: "[redacted]" },
    };
    expect(presentLog(row)).toEqual({
      object: "log",
      id: "log_1",
      created_at: row.created_at,
      endpoint: "/api-keys",
      method: "POST",
      response_status: 200,
      user_agent: "dispatch-node/0.1.0",
    });
    expect(presentLog(row, true)).toMatchObject({
      request_body: { name: "ci" },
      response_body: { token: "[redacted]" },
    });
    expect(presentLog(row)).not.toHaveProperty("request_body");
  });

  it("keeps the current password out of the log", () => {
    expect(redact({ current_password: "old one", password: "new one" })).toEqual({ current_password: "[redacted]", password: "[redacted]" });
  });

  it("keeps any secret-named key out of the log, in any case", () => {
    expect(redact({ new_password: "a", Password: "b", clientSecret: "c", API_KEY: "d", name: "Ada" })).toEqual({
      new_password: "[redacted]",
      Password: "[redacted]",
      clientSecret: "[redacted]",
      API_KEY: "[redacted]",
      name: "Ada",
    });
  });

  it("replaces token links for a read-only user and leaves other links alone", () => {
    const html = '<a href="https://api.acme.test/unsubscribe/tok_1">Unsubscribe</a> <a href="https://links.acme.test/click/tok_2">Shop</a> <img src="https://api.acme.test/open/tok_3.gif"> <a href="https://acme.test/pricing">Pricing</a>';
    expect(hideLinks(html)).toBe('<a href="#link-hidden">Unsubscribe</a> <a href="#link-hidden">Shop</a> <img src="#link-hidden"> <a href="https://acme.test/pricing">Pricing</a>');
    expect(hideLinks("Unsubscribe: https://api.acme.test/unsubscribe?token=abc\nBye")).toBe("Unsubscribe: #link-hidden\nBye");
    expect(hideLinks(null)).toBeNull();
  });

  describe.each(["http", "https", "HtTp", "hTtPs", "HTTP", "HTTPS"])("capability links with %s schemes", (scheme) => {
    const families = ["unsubscribe", "confirm", "inbound", "click", "open", "files", "shared"];

    it.each(families)("hides the accepted %s path and query forms", (family) => {
      expect(hideLinks(`${scheme}://api.acme.test/${family}/tok_${family}`)).toBe("#link-hidden");
      expect(hideLinks(`${scheme}://api.acme.test/${family}?token=tok_${family}`)).toBe("#link-hidden");
    });

    it("hides every HTML and text link in nested viewer logs without changing full-role bodies", () => {
      const links = families.map((family) => `${scheme}://api.acme.test/${family}/tok_${family}`);
      const ordinary = `Keep this text and ${scheme}://acme.test/pricing unchanged.`;
      const html = `${links.map((link) => `<a href="${link}">Continue</a>`).join(" ")} ${ordinary}`;
      const text = `${links.join("\n")}\n${ordinary}`;
      const hiddenHtml = `${links.map(() => '<a href="#link-hidden">Continue</a>').join(" ")} ${ordinary}`;
      const hiddenText = `${links.map(() => "#link-hidden").join("\n")}\n${ordinary}`;
      const row = {
        id: "log_1",
        created_at: "2026-10-01T00:00:00.000Z",
        path: "/emails/email_1",
        method: "GET",
        status: 200,
        request_body: { nested: [{ html, text, ordinary, count: 7, enabled: true, empty: null }] },
        response_body: { email: { html, text }, messages: [text, { html }], ordinary },
      };

      expect(hideLinks(html)).toBe(hiddenHtml);
      expect(hideLinks(text)).toBe(hiddenText);
      expect(presentLog(row, true, true)).toMatchObject({
        request_body: { nested: [{ html: hiddenHtml, text: hiddenText, ordinary, count: 7, enabled: true, empty: null }] },
        response_body: { email: { html: hiddenHtml, text: hiddenText }, messages: [hiddenText, { html: hiddenHtml }], ordinary },
      });
      expect(presentLog(row, true)).toMatchObject({
        request_body: row.request_body,
        response_body: row.response_body,
      });
      expect(row.request_body.nested[0]?.html).toBe(html);
      expect(row.response_body.email.text).toBe(text);
    });
  });

  it("cuts a webhook URL to its host for a read-only user", () => {
    expect(hostOnly("https://hooks.slack.com/services/T000/B000/secret")).toBe("https://hooks.slack.com/…");
    expect(hostOnly("https://user:pass@acme.test/")).toBe("https://acme.test/");
    expect(hostOnly("not a url")).toBe("#link-hidden");
  });

  it("hides share links and signed file URLs from a read-only user", () => {
    const row = {
      id: "log_1",
      created_at: "2026-10-01T00:00:00.000Z",
      path: "/emails/email_1/share",
      method: "POST",
      status: 200,
      request_body: { expires_in: "1h" },
      response_body: { object: "email", id: "email_1", url: "https://app.example.com/shared?token=abc", attachments: [{ download_url: "https://files/x" }], raw: "https://files/raw" },
    };
    expect(presentLog(row, true)).toMatchObject({ response_body: { url: "https://app.example.com/shared?token=abc" } });
    expect(presentLog(row, true, true)).toMatchObject({
      request_body: { expires_in: "1h" },
      response_body: { id: "email_1", url: "[redacted]", attachments: [{ download_url: "[redacted]" }], raw: "[redacted]" },
    });
    // A stored email body in a log keeps its links from a read-only user too.
    const email = { ...row, path: "/emails/email_1", method: "GET", response_body: { html: '<a href="https://api.acme.test/unsubscribe/tok_1">u</a>' } };
    expect(presentLog(email, true, true)).toMatchObject({ response_body: { html: '<a href="#link-hidden">u</a>' } });
  });
});
