import { describe, expect, it, vi } from "vitest";
import type { Step } from "@dispatchmail/core";
import { assertSendKinds } from "./send-kinds.js";

const send = (config: Record<string, unknown>): Step => ({ key: "send", type: "send_email", config: { template: "template_1", ...config } });
describe("send readiness", () => {
  it("allows an incomplete Marketing draft but never enables it", async () => {
    const db = { query: vi.fn() };
    await assertSendKinds(db, "tenant_1", [send({ kind: "marketing" })]);
    await expect(assertSendKinds(db, "tenant_1", [send({ kind: "marketing" })], true)).rejects.toMatchObject({ statusCode: 422 });
    expect(db.query).not.toHaveBeenCalled();
  });
  it("checks the topic in the same tenant and rejects deleted or foreign topics", async () => {
    const db = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    await expect(assertSendKinds(db, "tenant_1", [send({ kind: "marketing", topic_id: "foreign" })], true)).rejects.toMatchObject({ statusCode: 422 });
    expect(db.query.mock.calls[0][1]).toEqual(["tenant_1", "foreign"]);
  });
  it.each([{ html: "{{{UNSUBSCRIBE_URL}}}" }, { source: { send_kind: "marketing" } }])("refuses Marketing template content or metadata", async (template) => {
    const db = { query: vi.fn().mockResolvedValue({ rows: [template] }) };
    await expect(assertSendKinds(db, "tenant_1", [send({ kind: "transactional" })])).rejects.toMatchObject({ statusCode: 422 });
    expect(db.query.mock.calls[0][1]).toEqual(["tenant_1", "template_1"]);
  });
  it.each(["UNSUBSCRIBE_URL", "RESEND_UNSUBSCRIBE_URL", "DISPATCH_UNSUBSCRIBE_URL"])("refuses renderer-supported %s forms as Transactional", async (key) => {
    for (const token of [
      `{{${key}}}`, `{{ ${key} }}`, `{{{${key}}}}`, `{{{ ${key} }}}`,
      `{{{${key}|https://example.com/unsubscribe}}}`, `{{{${key}|}}}`,
    ]) {
      for (const field of ["html", "text"] as const) {
        const db = { query: vi.fn().mockResolvedValue({ rows: [{ [field]: token }] }) };
        // Both graph save and activation must refuse, without a Transactional fallback.
        for (const enabled of [false, true]) {
          await expect(assertSendKinds(db, "tenant_1", [send({ kind: "transactional" })], enabled)).rejects.toMatchObject({
            statusCode: 422, message: "Step send uses a Marketing template and must be Marketing",
          });
        }
      }
    }
  });
  it("checks Marketing content in both published and latest versions", async () => {
    for (const rows of [
      [{ text: "Edited receipt" }, { text: "{{{DISPATCH_UNSUBSCRIBE_URL|}}}" }],
      [{ text: "{{{RESEND_UNSUBSCRIBE_URL|fallback}}}" }, { text: "Edited receipt" }],
    ]) {
      const db = { query: vi.fn().mockResolvedValue({ rows }) };
      await expect(assertSendKinds(db, "tenant_1", [send({})], true)).rejects.toMatchObject({ statusCode: 422 });
    }
  });
  it("allows Marketing activation with a valid topic", async () => {
    const db = { query: vi.fn().mockResolvedValue({ rows: [{ id: "news" }] }) };
    await expect(assertSendKinds(db, "tenant_1", [send({ kind: "marketing", topic_id: "news" })], true)).resolves.toBeUndefined();
    expect(db.query.mock.calls[0][1]).toEqual(["tenant_1", "news"]);
  });
  it("allows ordinary Transactional templates without a topic", async () => {
    const db = { query: vi.fn().mockResolvedValue({ rows: [{ text: "Receipt" }] }) };
    await expect(assertSendKinds(db, "tenant_1", [send({})], true)).resolves.toBeUndefined();
  });
});
