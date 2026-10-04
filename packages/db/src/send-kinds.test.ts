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
  it("allows ordinary Transactional templates without a topic", async () => {
    const db = { query: vi.fn().mockResolvedValue({ rows: [{ text: "Receipt" }] }) };
    await expect(assertSendKinds(db, "tenant_1", [send({})], true)).resolves.toBeUndefined();
  });
});
