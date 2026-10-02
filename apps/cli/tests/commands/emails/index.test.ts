import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emails } from "../../../src/commands/emails/index.js";
import { input } from "../../../src/lib/files.js";
import { captureExit, errorJson, list, method, ok, run, setNonInteractive, spies } from "../../helpers.js";

vi.mock("@dispatchmail/sdk", async () => (await import("../../helpers.js")).sdk);
vi.mock("../../../src/lib/react.js", () => ({
  renderFile: vi.fn(async (_file: string, props?: { name?: string }) => ({
    html: `<p>Hi ${props?.name ?? "preview"}</p>`,
    subject: "Welcome",
    variables: [],
  })),
}));

const dir = mkdtempSync(join(tmpdir(), "dispatch-emails-"));

describe("emails", () => {
  beforeEach(() => {
    setNonInteractive();
    captureExit();
    input.used = false;
  });
  afterEach(() => {
    input.stdin = process.stdin;
  });

  it("lists by default with page and filters", async () => {
    method("emails.list").mockResolvedValue(list([{ id: "email_1" }]));
    const { stdout } = spies();
    expect(await run(emails, ["--limit", "3", "--status", "bounced"])).toBe(0);
    expect(method("emails.list")).toHaveBeenCalledWith({ limit: 3, status: "bounced" });
    expect(JSON.parse(stdout()).data[0].id).toBe("email_1");
  });

  it("send builds a camelCase payload from flags", async () => {
    method("emails.send").mockResolvedValue(ok({ id: "email_1" }));
    const file = join(dir, "a.pdf");
    writeFileSync(file, "pdf");
    const { stdout } = spies();
    const code = await run(emails, [
      "send",
      "--from",
      "hello@acme.com",
      "--to",
      "a@x.com,b@x.com",
      "--cc",
      "c@x.com",
      "--reply-to",
      "r@x.com",
      "--subject",
      "Hi",
      "--text",
      "Hello",
      "--headers",
      "X-Trace=1",
      "--tags",
      "kind=welcome",
      "--scheduled-at",
      "in 1 hour",
      "--attachment",
      `${file};type=application/pdf`,
      "--idempotency-key",
      "key-1",
    ]);
    expect(code).toBe(0);
    expect(method("emails.send")).toHaveBeenCalledWith(
      {
        from: "hello@acme.com",
        to: ["a@x.com", "b@x.com"],
        cc: ["c@x.com"],
        replyTo: ["r@x.com"],
        subject: "Hi",
        text: "Hello",
        headers: { "X-Trace": "1" },
        tags: { kind: "welcome" },
        scheduledAt: "in 1 hour",
        attachments: [{ filename: "a.pdf", content: Buffer.from("pdf").toString("base64"), contentType: "application/pdf" }],
      },
      { idempotencyKey: "key-1" },
    );
    expect(JSON.parse(stdout())).toEqual({ id: "email_1" });
  });

  it("send with a template does not need --from, since the template can carry its sender", async () => {
    method("emails.send").mockResolvedValue(ok({ id: "email_2" }));
    spies();
    expect(await run(emails, ["send", "--to", "a@x.com", "--template", "welcome", "--var", "NAME=Ada"])).toBe(0);
    expect(method("emails.send")).toHaveBeenLastCalledWith(
      { to: ["a@x.com"], template: { id: "welcome", variables: { NAME: "Ada" } } },
      expect.anything(),
    );
  });

  it("send fails with missing_flags instead of inventing defaults", async () => {
    const { stderr } = spies();
    expect(await run(emails, ["send", "--text", "x"])).toBe(1);
    expect(errorJson(stderr()).error).toEqual({ code: "missing_flags", message: "Missing required flags: --from, --to, --subject" });
    expect(method("emails.send")).not.toHaveBeenCalled();
  });

  it("send with a template needs no subject or body and passes --var", async () => {
    method("emails.send").mockResolvedValue(ok({ id: "email_2" }));
    spies();
    await run(emails, [
      "send",
      "--from",
      "a@acme.com",
      "--to",
      "b@x.com",
      "--template",
      "password-reset",
      "--var",
      "ACTION_URL=https://x/r",
    ]);
    expect(method("emails.send").mock.calls[0]![0]).toEqual({
      from: "a@acme.com",
      to: ["b@x.com"],
      template: { id: "password-reset", variables: { ACTION_URL: "https://x/r" } },
    });
  });

  it("send --react-email renders HTML with --props and uses the component subject", async () => {
    method("emails.send").mockResolvedValue(ok({ id: "email_3" }));
    spies();
    await run(emails, ["send", "--from", "a@acme.com", "--to", "b@x.com", "--react-email", "welcome.tsx", "--props", '{"name":"Ada"}']);
    expect(method("emails.send").mock.calls[0]![0]).toMatchObject({ subject: "Welcome", html: "<p>Hi Ada</p>" });
  });

  it("send reads --html-file from stdin", async () => {
    method("emails.send").mockResolvedValue(ok({ id: "email_4" }));
    input.stdin = Readable.from([Buffer.from("<b>piped</b>")]);
    spies();
    await run(emails, ["send", "--from", "a@acme.com", "--to", "b@x.com", "--subject", "S", "--html-file", "-"]);
    expect(method("emails.send").mock.calls[0]![0]).toMatchObject({ html: "<b>piped</b>" });
  });

  it("send --dry-run prints the payload and does not call the API", async () => {
    const { stdout } = spies();
    await run(emails, ["send", "--from", "a@acme.com", "--to", "b@x.com", "--subject", "S", "--text", "T", "--dry-run"]);
    expect(JSON.parse(stdout())).toEqual({ object: "dry_run", payload: { from: "a@acme.com", to: ["b@x.com"], subject: "S", text: "T" } });
    expect(method("emails.send")).not.toHaveBeenCalled();
  });

  it("batch reads a JSON array from --file and passes batch options", async () => {
    const file = join(dir, "batch.json");
    writeFileSync(file, JSON.stringify([{ from: "a@acme.com", to: "b@x.com", subject: "1", text: "x" }]));
    method("batch.send").mockResolvedValue(ok({ data: [{ id: "email_1" }] }));
    spies();
    expect(await run(emails, ["batch", "--file", file, "--batch-validation", "strict", "--idempotency-key", "k"])).toBe(0);
    expect(method("batch.send")).toHaveBeenCalledWith([{ from: "a@acme.com", to: "b@x.com", subject: "1", text: "x" }], {
      idempotencyKey: "k",
      batchValidation: "strict",
    });
  });

  it("batch without --file fails with missing_flags", async () => {
    const { stderr } = spies();
    expect(await run(emails, ["batch"])).toBe(1);
    expect(errorJson(stderr()).error.code).toBe("missing_flags");
  });

  it("maps cancel, update, share, retry, events, and attachments to the SDK", async () => {
    spies();
    await run(emails, ["cancel", "email_1"]);
    expect(method("emails.cancel")).toHaveBeenCalledWith("email_1");
    await run(emails, ["update", "email_1", "--scheduled-at", "tomorrow"]);
    expect(method("emails.update")).toHaveBeenCalledWith({ id: "email_1", scheduledAt: "tomorrow" });
    await run(emails, ["share", "email_1", "--expires-in", "7d"]);
    expect(method("emails.share")).toHaveBeenCalledWith("email_1", { expiresIn: "7d" });
    await run(emails, ["retry", "email_1"]);
    expect(method("emails.retry")).toHaveBeenCalledWith("email_1");
    method("emails.events").mockResolvedValue(list([]));
    await run(emails, ["events", "email_1"]);
    expect(method("emails.events")).toHaveBeenCalledWith("email_1", { limit: 10 });
    method("emails.attachments.list").mockResolvedValue(list([]));
    await run(emails, ["attachments", "email_1"]);
    expect(method("emails.attachments.list")).toHaveBeenCalledWith({ emailId: "email_1", limit: 10 });
    await run(emails, ["attachment", "email_1", "att_1"]);
    expect(method("emails.attachments.get")).toHaveBeenCalledWith({ emailId: "email_1", id: "att_1" });
    await run(emails, ["metrics", "--metrics", "sent,delivered", "--granularity", "daily"]);
    expect(method("emails.metrics")).toHaveBeenCalledWith({ metrics: ["sent", "delivered"], granularity: "daily" });
  });
});
