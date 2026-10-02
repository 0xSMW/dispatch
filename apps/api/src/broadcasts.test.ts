import { describe, expect, it } from "vitest";
import { broadcastRecipientsSchema, broadcastSchema, broadcastSendSchema, broadcastUpdateSchema } from "@dispatchmail/core";
import { pageRows } from "./broadcasts.js";

describe("broadcast schemas", () => {
  const base = { from: "Acme <hello@example.com>", subject: "Hello", html: "<p>Hi</p>" };

  it("requires segment_id and accepts audience_id as its alias", () => {
    expect(() => broadcastSchema.parse(base)).toThrow("segment_id is required");
    expect(broadcastSchema.parse({ ...base, audience_id: "segment_1" })).toMatchObject({ segment_id: "segment_1" });
    expect(broadcastSchema.parse({ ...base, audience_id: "segment_1" })).not.toHaveProperty("audience_id");
  });

  it("takes Resend's create fields and a single reply_to", () => {
    const input = broadcastSchema.parse({
      ...base,
      segment_id: "segment_1",
      reply_to: "reply@example.com",
      preview_text: "Inside",
      topic_id: "topic_1",
      send: true,
      scheduled_at: "in 1 hour",
    });
    expect(input).toMatchObject({ reply_to: ["reply@example.com"], preview_text: "Inside", send: true, scheduled_at: "in 1 hour" });
  });

  it("allows scheduled_at only with send: true", () => {
    expect(() => broadcastSchema.parse({ ...base, segment_id: "segment_1", scheduled_at: "tomorrow" })).toThrow("send: true");
  });

  it("takes a partial update and an optional send body", () => {
    expect(broadcastUpdateSchema.parse({ name: "New", html: null })).toEqual({ name: "New", html: null, segment_id: undefined });
    expect(() => broadcastUpdateSchema.parse({ status: "sent" })).toThrow();
    expect(broadcastSendSchema.parse({})).toEqual({});
    expect(broadcastSendSchema.parse({ scheduled_at: "in 5 minutes" })).toEqual({ scheduled_at: "in 5 minutes" });
  });

  it("requires a known recipients type", () => {
    expect(() => broadcastRecipientsSchema.parse({})).toThrow();
    expect(() => broadcastRecipientsSchema.parse({ type: "read" })).toThrow();
    expect(broadcastRecipientsSchema.parse({ type: "bounced", bounce_type: "Permanent" })).toEqual({ type: "bounced", bounce_type: "Permanent" });
  });
});

describe("pageRows", () => {
  const rows = ["a", "b", "c", "d", "e"].map((id) => ({ id }));

  it("pages forward with after and backward with before", () => {
    expect(pageRows(rows, { limit: 2 })).toEqual({ object: "list", has_more: true, data: [{ id: "a" }, { id: "b" }] });
    expect(pageRows(rows, { limit: 2, after: "b" })).toEqual({ object: "list", has_more: true, data: [{ id: "c" }, { id: "d" }] });
    expect(pageRows(rows, { limit: 2, after: "d" })).toEqual({ object: "list", has_more: false, data: [{ id: "e" }] });
    expect(pageRows(rows, { limit: 2, before: "e" })).toEqual({ object: "list", has_more: true, data: [{ id: "c" }, { id: "d" }] });
    expect(pageRows(rows, { limit: 2, after: "zzz" }).data).toEqual([]);
  });

  it("rejects both cursors and an out-of-range limit", () => {
    expect(() => pageRows(rows, { after: "a", before: "c" })).toThrow("Use after or before");
    expect(() => pageRows(rows, { limit: 101 })).toThrow("limit");
  });
});
