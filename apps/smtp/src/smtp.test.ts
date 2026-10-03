import { describe, expect, it, vi } from "vitest";
import { ApiError, hash, keyHash, sendSchema } from "@dispatchmail/core";
import PostalMime from "postal-mime";
import {
  authenticate,
  deliveryKey,
  handleMessage,
  idempotencyKey,
  maxBytes,
  ports,
  rateLimit,
  recipientReply,
  smtpReply,
  toSendInputs,
  type Auth,
  type Deps,
} from "./smtp.js";

const pepper = "test-pepper";
const fullSecret = "sk_fullkey000000000000000000";
const sendSecret = "sk_sendkey000000000000000000";
const revokedSecret = "sk_revoked000000000000000000";

type KeyRow = {
  id: string;
  tenant_id: string;
  prefix: string;
  hash: string;
  scope: "full" | "send";
  revoked_at: string | null;
  last_used_at: string | null;
  domain_id: string | null;
  domain_name: string | null;
};

function key(secret: string, scope: "full" | "send", revoked = false): KeyRow {
  return {
    id: `key_${scope}${revoked ? "_revoked" : ""}`,
    tenant_id: "tenant_1",
    prefix: secret.slice(0, 12),
    hash: keyHash(secret, pepper),
    scope,
    revoked_at: revoked ? "2026-09-01T00:00:00.000Z" : null,
    last_used_at: null,
    domain_id: null,
    domain_name: null,
  };
}

function fakeDb(rows = [key(fullSecret, "full"), key(sendSecret, "send"), key(revokedSecret, "full", true)]) {
  const queries: string[] = [];
  const db = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      queries.push(sql);
      if (sql.includes("from api_keys k")) {
        if (sql.includes("where k.id = $1")) {
          return { rows: rows.filter((row) => row.id === params[0] && row.tenant_id === params[1] && !row.revoked_at) };
        }
        return { rows: rows.filter((row) => row.prefix === params[0] && !row.revoked_at) };
      }
      return { rows: [], rowCount: 1 };
    }),
  };
  return { db: db as unknown as Deps["db"], queries };
}

const auth: Auth = {
  tenant_id: "tenant_1",
  api_key_id: "key_send",
  scope: "send",
  domain_name: null,
};

function deps(overrides: Partial<Deps> = {}) {
  const put = vi.fn(async () => undefined);
  const accept = vi.fn(async () => ({ email: { id: "email_123" } }));
  const value = {
    db: fakeDb().db,
    storage: { put },
    pepper,
    accept: accept as unknown as Deps["accept"],
    ...overrides,
  } satisfies Deps;
  return { deps: value, put, accept };
}

const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

const related = Buffer.from(
  [
    'From: "Acme Team" <hello@acme.com>',
    "To: Ada <ada@example.com>, bob@example.com",
    "Cc: Cy <cy@example.com>",
    "Reply-To: Support <support@acme.com>",
    "Subject: Welcome",
    "Message-ID: <m1@acme.com>",
    "X-Entity-Ref-ID: ref-42",
    "Resend-Idempotency-Key: welcome-ada",
    "MIME-Version: 1.0",
    'Content-Type: multipart/related; boundary="rel"',
    "",
    "--rel",
    'Content-Type: multipart/alternative; boundary="alt"',
    "",
    "--alt",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Hello Ada",
    "--alt",
    "Content-Type: text/html; charset=utf-8",
    "",
    '<p>Hello Ada</p><img src="cid:logo@acme">',
    "--alt--",
    "--rel",
    "Content-Type: image/png",
    "Content-Transfer-Encoding: base64",
    "Content-ID: <logo@acme>",
    'Content-Disposition: inline; filename="logo.png"',
    "",
    png.toString("base64"),
    "--rel--",
    "",
  ].join("\r\n"),
);

const envelope = (...addresses: string[]) => ({
  mailFrom: { address: "hello@acme.com", args: {} },
  rcptTo: addresses.map((address) => ({ address, args: {} })),
});

function plain(headers: string[]) {
  return Buffer.from(
    [...headers, "Content-Type: text/plain", "", "Hi", ""].join("\r\n"),
  );
}

describe("authenticate", () => {
  it("accepts an API key with the dispatch or resend username", async () => {
    const { db, queries } = fakeDb();
    for (const username of ["dispatch", "resend", "Resend"]) {
      const result = await authenticate({ db, pepper }, username, fullSecret);
      expect(result).toEqual({
        tenant_id: "tenant_1",
        api_key_id: "key_full",
        scope: "full",
        domain_name: null,
      });
    }
    expect(queries.some((sql) => sql.includes("update api_keys set last_used_at"))).toBe(true);
  });

  it("allows a send scoped key", async () => {
    const { db } = fakeDb();
    const result = await authenticate({ db, pepper }, "dispatch", sendSecret);
    expect(result.scope).toBe("send");
    expect(result.api_key_id).toBe("key_send");
  });

  it("rejects an unknown, revoked, or wrong key and an unknown username", async () => {
    const { db } = fakeDb();
    const attempts: Array<[string, string]> = [
      ["dispatch", "sk_unknown00000000000000000"],
      ["dispatch", revokedSecret],
      ["dispatch", `${fullSecret.slice(0, 12)}wrongwrongwrong`],
      ["dispatch", ""],
      ["admin", fullSecret],
    ];
    for (const [username, password] of attempts) {
      const error = await authenticate({ db, pepper }, username, password).catch((e) => e);
      expect(error).toBeInstanceOf(ApiError);
      expect(smtpReply(error).code).toBe(535);
    }
  });

  it("rejects a key hashed with another pepper", async () => {
    const { db } = fakeDb();
    await expect(authenticate({ db, pepper: "other" }, "dispatch", fullSecret)).rejects.toMatchObject({
      name: "invalid_api_key",
    });
  });
});

describe("toSendInputs", () => {
  it("maps headers, bodies, and an inline image", async () => {
    const email = await PostalMime.parse(related);
    const inputs = toSendInputs(
      email,
      envelope("ada@example.com", "bob@example.com", "cy@example.com", "audit@acme.com"),
    );
    expect(inputs).toHaveLength(1);
    const input = inputs[0]!;
    expect(input).toMatchObject({
      from: "Acme Team <hello@acme.com>",
      to: ["ada@example.com", "bob@example.com"],
      cc: ["cy@example.com"],
      bcc: ["audit@acme.com"],
      reply_to: ["Support <support@acme.com>"],
      subject: "Welcome",
      headers: { "X-Entity-Ref-ID": "ref-42" },
    });
    expect(input.text).toContain("Hello Ada");
    expect(input.html).toContain('src="cid:logo@acme"');
    expect(input.headers).not.toHaveProperty("Resend-Idempotency-Key");
    expect(input.headers).not.toHaveProperty("Message-ID");
    expect(input.attachments).toEqual([
      {
        filename: "logo.png",
        content: png.toString("base64"),
        content_type: "image/png",
        content_id: "logo@acme",
        disposition: "inline",
      },
    ]);
    expect(input).not.toHaveProperty("scheduled_at");
  });

  it("takes the sender from the envelope, and gives each recipient no header names an email of their own", async () => {
    const email = await PostalMime.parse(plain(["Subject: Hi"]));
    const inputs = toSendInputs(email, envelope("one@example.com", "ONE@example.com", "two@example.com"));
    expect(inputs.map((input) => input.to)).toEqual([["one@example.com"], ["two@example.com"]]);
    expect(inputs.every((input) => input.from === "hello@acme.com" && !input.cc && !input.bcc)).toBe(true);
  });

  it("sends only to envelope recipients, even when the headers name more", async () => {
    const email = await PostalMime.parse(
      plain(["From: hello@acme.com", "To: ada@example.com, grace@example.com", "Cc: linus@example.com", "Subject: Hi"]),
    );
    const [input] = toSendInputs(email, envelope("Grace@example.com", "hidden@example.com"));
    expect(input!.to).toEqual(["grace@example.com"]);
    expect(input!.cc).toBeUndefined();
    expect(input!.bcc).toEqual(["hidden@example.com"]);
  });

  it("never shows hidden recipients to each other", async () => {
    // A Bcc-only send as Thunderbird, Outlook, and mutt write it.
    const bccOnly = await PostalMime.parse(plain(["From: hello@acme.com", "To: undisclosed-recipients:;", "Subject: Hi"]));
    const hidden = toSendInputs(bccOnly, envelope("alice@a.com", "bob@b.com"));
    expect(hidden.map((input) => input.to)).toEqual([["alice@a.com"], ["bob@b.com"]]);
    for (const input of hidden) expect(sendSchema.safeParse(input).success).toBe(true);

    // A list expander: the header names the list, the envelope its members.
    const list = await PostalMime.parse(plain(["From: hello@acme.com", "To: team@acme.com", "Subject: Hi"]));
    const members = toSendInputs(list, envelope("ann@x.com", "bob@y.com", "cy@z.com"));
    expect(members.map((input) => input.to)).toEqual([["ann@x.com"], ["bob@y.com"], ["cy@z.com"]]);

    // A client that leaves the Bcc header in the message.
    const kept = await PostalMime.parse(
      plain(["From: hello@acme.com", "To: undisclosed-recipients:;", "Bcc: x@y.com, z@y.com", "Subject: Hi"]),
    );
    expect(toSendInputs(kept, envelope("x@y.com", "z@y.com")).map((input) => input.to)).toEqual([["x@y.com"], ["z@y.com"]]);
  });

  it("delivers the second envelope of a split send to its Cc recipient", async () => {
    const email = await PostalMime.parse(plain(["From: hello@acme.com", "To: a@a.com", "Cc: b@b.com", "Subject: Hi"]));
    const [second] = toSendInputs(email, envelope("b@b.com"));
    expect(second).toMatchObject({ to: ["b@b.com"] });
    expect(second!.cc).toBeUndefined();
    expect(sendSchema.safeParse(second).success).toBe(true);
  });

  it("drops SES control headers and empty attachments, and gives an attachment-only message a body", async () => {
    const email = await PostalMime.parse(
      Buffer.from(
        [
          "From: hello@acme.com",
          "To: ada@example.com",
          "Subject: Scan",
          "X-SES-MESSAGE-TAGS: dispatch_tenant_id=tenant_other",
          "X-SES-CONFIGURATION-SET: none",
          "X-Keep: yes",
          "MIME-Version: 1.0",
          'Content-Type: multipart/mixed; boundary="m"',
          "",
          "--m",
          "Content-Type: application/pdf",
          "Content-Transfer-Encoding: base64",
          'Content-Disposition: attachment; filename="scan.pdf"',
          "",
          Buffer.from("%PDF-1.4").toString("base64"),
          "--m",
          "Content-Type: text/plain",
          'Content-Disposition: attachment; filename="empty.log"',
          "",
          "--m",
          "Content-Type: text/calendar",
          "Content-Disposition: attachment",
          "",
          "BEGIN:VCALENDAR",
          "--m--",
          "",
        ].join("\r\n"),
      ),
    );
    const [input] = toSendInputs(email, envelope("ada@example.com"));
    expect(input!.headers).toEqual({ "X-Keep": "yes" });
    expect(input!.attachments!.map((attachment) => attachment.filename)).toEqual(["scan.pdf", "attachment.ics"]);
    expect(input!.text).toBe(" ");
    expect(sendSchema.safeParse(input).success).toBe(true);
  });
});

describe("deliveryKey", () => {
  const recipients = (...addresses: string[]) => hash(addresses.join(",")).slice(0, 16);

  it("scopes a client's key to the envelope, so one message in two envelopes is two deliveries", async () => {
    const email = await PostalMime.parse(related);
    const first = deliveryKey(email, envelope("ada@example.com"));
    const second = deliveryKey(email, envelope("cy@example.com"));
    expect(first).toBe(`welcome-ada:${recipients("ada@example.com")}`);
    expect(second).not.toBe(first);
    // The same envelope in another order or case is the same delivery.
    expect(deliveryKey(email, envelope("Bob@example.com", "ada@example.com"))).toBe(deliveryKey(email, envelope("ada@example.com", "bob@example.com")));
  });

  it("stands in the Message-ID when the client sent no key, and gives none without either", async () => {
    const email = await PostalMime.parse(plain(["From: hello@acme.com", "To: ada@example.com", "Message-ID: <m9@acme.com>", "Subject: Hi"]));
    const key = deliveryKey(email, envelope("ada@example.com"));
    expect(key).toMatch(/^smtp:[0-9a-f]{32}:[0-9a-f]{16}$/);
    expect(deliveryKey(email, envelope("ada@example.com"))).toBe(key);
    expect(deliveryKey(await PostalMime.parse(plain(["Subject: Hi"])), envelope("ada@example.com"))).toBeUndefined();
  });
});

describe("rateLimit", () => {
  it("counts into the tenant's bucket and refuses once it is over the limit", async () => {
    const calls: string[] = [];
    const redis = (count: number) => ({
      multi: () => ({
        incr: (key: string) => calls.push(`incr ${key}`),
        expire: (key: string, seconds: number) => calls.push(`expire ${key} ${seconds}`),
        exec: async () => [[null, count], [null, 1]] as Array<[Error | null, unknown]>,
      }),
    });
    await expect(rateLimit(redis(10), "tenant_1", 1_700_000_000_500)).resolves.toBeUndefined();
    expect(calls).toEqual(["incr rate:tenant_1:1700000000", "expire rate:tenant_1:1700000000 2"]);
    await expect(rateLimit(redis(11), "tenant_1", 1_700_000_000_500)).rejects.toMatchObject({ name: "rate_limit_exceeded", statusCode: 429 });
  });
});

describe("idempotencyKey", () => {
  it("reads Dispatch-Idempotency-Key before Resend-Idempotency-Key", async () => {
    expect(idempotencyKey(await PostalMime.parse(related))).toBe("welcome-ada");
    const both = await PostalMime.parse(
      plain(["Resend-Idempotency-Key: resend-1", "Dispatch-Idempotency-Key: dispatch-1"]),
    );
    expect(idempotencyKey(both)).toBe("dispatch-1");
    expect(idempotencyKey(await PostalMime.parse(plain(["Subject: x"])))).toBeUndefined();
  });

  it("rejects a key longer than 256 characters", async () => {
    const email = await PostalMime.parse(plain([`Dispatch-Idempotency-Key: ${"k".repeat(257)}`]));
    expect(() => idempotencyKey(email)).toThrow(ApiError);
  });
});

describe("handleMessage", () => {
  it("rejects DATA after the authenticated key is revoked, including repeated attempts", async () => {
    const row = key(sendSecret, "send");
    const { db } = fakeDb([row]);
    const { deps: value, accept } = deps({ db });
    const session = await authenticate(value, "dispatch", sendSecret);
    await handleMessage(value, session, related, envelope("ada@example.com"));
    await handleMessage(value, session, related, envelope("bob@example.com"));
    expect(accept).toHaveBeenCalledTimes(2);
    row.revoked_at = new Date().toISOString();
    for (let attempt = 0; attempt < 2; attempt++) {
      const error = await handleMessage(value, session, related, envelope("ada@example.com")).catch((error) => error);
      expect(smtpReply(error).code).toBe(535);
    }
    expect(accept).toHaveBeenCalledTimes(2);
  });

  it("refreshes domain restrictions and requires the authenticated tenant", async () => {
    const row = key(sendSecret, "send");
    const { db } = fakeDb([row]);
    const { deps: value, accept } = deps({ db });
    const session = await authenticate(value, "dispatch", sendSecret);
    row.domain_id = "domain_1";
    row.domain_name = "acme.com";
    await handleMessage(value, session, related, envelope("ada@example.com"));
    expect(accept).toHaveBeenLastCalledWith(db, expect.anything(), expect.objectContaining({ domain_name: "acme.com" }), expect.anything());
    row.domain_name = null;
    await expect(handleMessage(value, session, related, envelope("ada@example.com"))).rejects.toMatchObject({ name: "restricted_api_key" });
    row.tenant_id = "tenant_2";
    await expect(handleMessage(value, session, related, envelope("ada@example.com"))).rejects.toMatchObject({ name: "invalid_api_key" });
    expect(accept).toHaveBeenCalledTimes(1);
  });

  it("accepts with a plain context and stores attachments through storage", async () => {
    const { deps: value, accept, put } = deps();
    const id = await handleMessage(value, auth, related, envelope("ada@example.com"));
    expect(id).toBe("email_123");
    const call = accept.mock.calls[0] as unknown as [unknown, Record<string, unknown>, Record<string, unknown>, { storeAttachment: (key: string, bytes: Buffer) => Promise<void> }];
    expect(call[1]).toMatchObject({ from: "Acme Team <hello@acme.com>", subject: "Welcome" });
    expect(call[2]).toMatchObject({
      tenant_id: "tenant_1",
      api_key_id: "key_send",
      idempotency_key: deliveryKey(await PostalMime.parse(related), envelope("ada@example.com")),
      domain_name: null,
    });
    expect(call[2].request_id).toMatch(/^req_/);
    await call[3].storeAttachment("attachments/t/e/a", png);
    expect(put).toHaveBeenCalledWith("attachments/t/e/a", png);
  });

  it("calls the rate limit hook with the tenant", async () => {
    const limit = vi.fn(async () => {
      throw new ApiError("rate_limit_exceeded", 429, "Rate limit exceeded");
    });
    const { deps: value, accept } = deps({ limit });
    const error = await handleMessage(value, auth, related, envelope("ada@example.com")).catch((e) => e);
    expect(limit).toHaveBeenCalledWith("tenant_1");
    expect(accept).not.toHaveBeenCalled();
    expect(smtpReply(error).code).toBe(451);
  });

  it("sends one email per hidden recipient, each under its own key, and replies with the first", async () => {
    let next = 0;
    const accept = vi.fn(async () => ({ email: { id: `email_${next++}` } }));
    const { deps: value } = deps({ accept: accept as unknown as Deps["accept"] });
    const raw = plain(["From: hello@acme.com", "To: undisclosed-recipients:;", "Message-ID: <b1@acme.com>", "Subject: Hi"]);
    const id = await handleMessage(value, auth, raw, envelope("alice@a.com", "bob@b.com"));
    expect(id).toBe("email_0");
    const calls = accept.mock.calls as unknown as Array<[unknown, { to: string[] }, { idempotency_key: string }]>;
    expect(calls.map((call) => call[1].to)).toEqual([["alice@a.com"], ["bob@b.com"]]);
    expect(calls[0]![2].idempotency_key).toMatch(/:0$/);
    expect(calls[1]![2].idempotency_key).toMatch(/:1$/);
  });

  it("fails a message the parser cannot read for good, so the client does not retry it for days", async () => {
    const { deps: value } = deps();
    const nested = Array.from({ length: 300 }, (_, index) => [`Content-Type: multipart/mixed; boundary="b${index}"`, "", `--b${index}`]).flat();
    const raw = Buffer.from(["From: hello@acme.com", "To: ada@example.com", "Subject: Deep", ...nested, "Content-Type: text/plain", "", "x", ""].join("\r\n"));
    const error = await handleMessage(value, auth, raw, envelope("ada@example.com")).catch((e) => e);
    expect(smtpReply(error).code).toBe(550);
    expect(smtpReply(error).message).toContain("could not be parsed");
  });

  it("caps the envelope at 50 recipients", async () => {
    const { deps: value, accept } = deps();
    const many = Array.from({ length: 51 }, (_, index) => `r${index}@example.com`);
    const envelopeError = await handleMessage(value, auth, related, envelope(...many)).catch((e) => e);
    expect(smtpReply(envelopeError).code).toBe(550);
    expect(accept).not.toHaveBeenCalled();

    expect(recipientReply(49)).toBeNull();
    expect(recipientReply(50)?.code).toBe(452);
  });

  it("rejects a message over 40 MB", async () => {
    const { deps: value } = deps();
    const error = await handleMessage(value, auth, Buffer.alloc(maxBytes + 1), envelope("ada@example.com")).catch((e) => e);
    expect(smtpReply(error).code).toBe(552);
  });
});

describe("smtpReply", () => {
  it("maps API errors to SMTP replies", () => {
    const cases: Array<[ApiError, number]> = [
      [new ApiError("missing_api_key", 401, "Missing API key"), 535],
      [new ApiError("invalid_api_key", 403, "Invalid API key"), 535],
      [new ApiError("validation_error", 403, "Sender domain is not verified"), 550],
      [new ApiError("validation_error", 422, "An email can have at most 50 recipients"), 550],
      [new ApiError("invalid_attachment", 422, "Attachment content must be base64"), 550],
      [new ApiError("invalid_attachment", 422, "Attachments exceed 40 MB after base64 encoding"), 552],
      [new ApiError("message_too_large", 413, "Message exceeds 40 MB"), 552],
      [new ApiError("rate_limit_exceeded", 429, "Rate limit exceeded"), 451],
      [new ApiError("invalid_idempotent_request", 409, "Idempotency key was used with a different payload"), 550],
      [new ApiError("concurrent_idempotent_requests", 409, "Idempotency request is still in flight"), 451],
      [new ApiError("application_error", 500, "boom"), 451],
    ];
    for (const [error, code] of cases) {
      expect(smtpReply(error).code, error.name).toBe(code);
    }
    expect(smtpReply(new ApiError("validation_error", 403, "Sender domain is not verified")).message).toBe(
      "5.6.0 Sender domain is not verified",
    );
  });

  it("maps a zod error to 550 and anything else to a temporary failure", () => {
    const zod = Object.assign(new Error("invalid"), {
      name: "ZodError",
      issues: [{ path: ["subject"], message: "subject is required without a template" }],
    });
    expect(smtpReply(zod)).toEqual({ code: 550, message: "5.6.0 subject: subject is required without a template" });
    expect(smtpReply(new Error("socket hang up")).code).toBe(451);
  });
});

describe("ports", () => {
  it("reads one port or several, and falls back when the setting is unset or empty", () => {
    expect(ports(undefined, [587, 2587])).toEqual([587, 2587]);
    expect(ports("", [465, 2465])).toEqual([465, 2465]);
    expect(ports("2587", [587, 2587])).toEqual([2587]);
    expect(ports("587, 2587,587", [1])).toEqual([587, 2587]);
    expect(ports("abc,70000,-1", [587])).toEqual([587]);
  });
});
