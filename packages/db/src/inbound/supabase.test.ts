import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { mapSupabase, supabaseEventId } from "./supabase.js";

const record = {
  id: "user_synthetic", email: "ADA@example.com",
  raw_user_meta_data: { first_name: "Ada", last_name: "Lovelace", role: "admin" },
  encrypted_password: "synthetic_do_not_copy", confirmation_token: "synthetic_do_not_copy"
};
const payload = { schema: "auth", table: "users", type: "INSERT", record, old_record: null };

describe("Supabase Database Webhooks mapping", () => {
  it.each([
    ["INSERT", "supabase.user.created"], ["UPDATE", "supabase.user.updated"]
  ])("maps auth.users %s with no sensitive auth fields", (type, name) => {
    expect(mapSupabase({ ...payload, type })).toEqual({
      action: "upsert", lookup: { email: "ada@example.com" },
      contact: { first_name: "Ada", last_name: "Lovelace", properties: { supabase_user_id: "user_synthetic" } },
      event: {
        name, data: {
          user_id: "user_synthetic", email: "ada@example.com", first_name: "Ada", last_name: "Lovelace",
          properties: { supabase_user_id: "user_synthetic" }
        }
      }
    });
  });

  it("does not import arbitrary user-controlled metadata into contact properties", () => {
    const result = mapSupabase({ ...payload, record: { ...record, raw_user_meta_data: { plan: "pro", activated: true } } });
    if (result.action !== "upsert") throw new Error("Expected upsert");
    expect(result.contact).toEqual({ properties: { supabase_user_id: record.id } });
  });

  it("ignores unrelated tables, schemas, Auth Hooks and unsupported deletes", () => {
    for (const value of [
      { ...payload, schema: "public" }, { ...payload, table: "profiles" },
      { ...payload, type: "DELETE", record: null, old_record: record },
      { user: record, email_data: {} }
    ]) expect(mapSupabase(value)).toEqual({ action: "ignored", reason: "unsupported_event" });
  });

  it("does not fall back to the old email or create a phone-only contact", () => {
    expect(mapSupabase({ ...payload, type: "UPDATE", record: { ...record, email: null }, old_record: record }))
      .toEqual({ action: "ignored", reason: "no_contact" });
    expect(mapSupabase({ ...payload, record: { ...record, email: "invalid" } }))
      .toEqual({ action: "ignored", reason: "no_contact" });
  });

  it("ignores malformed records and leaves valid input untouched", () => {
    for (const value of [null, [], { ...payload, record: null }, { ...payload, record: { email: record.email } }]) {
      expect(mapSupabase(value)).toEqual({ action: "ignored", reason: "invalid_payload" });
    }
    const before = structuredClone(payload);
    mapSupabase(payload);
    expect(payload).toEqual(before);
  });
});

describe("Supabase raw-body delivery ID", () => {
  it("uses the untouched body plus the optional commit_timestamp", () => {
    const timestamp = "2026-10-04T12:00:00Z";
    const body = `{\n "commit_timestamp": "${timestamp}", "record": {"id": "synthetic"}\n}\n`;
    const expected = createHash("sha256").update(body).update(timestamp).digest("hex");
    expect(supabaseEventId(body)).toBe(expected);
    expect(supabaseEventId(Buffer.from(body))).toBe(expected);
    expect(supabaseEventId(body)).toBe(supabaseEventId(body));
    expect(supabaseEventId(JSON.stringify(JSON.parse(body)))).not.toBe(expected);
    expect(supabaseEventId(body.replace(timestamp, "2026-10-04T12:00:01Z"))).not.toBe(expected);
  });

  it("handles official payloads without a commit timestamp and invalid raw bodies", () => {
    const body = JSON.stringify(payload);
    expect(supabaseEventId(body)).toBe(createHash("sha256").update(body).digest("hex"));
    expect(supabaseEventId("not json")).toBe(createHash("sha256").update("not json").digest("hex"));
    expect(supabaseEventId(Uint8Array.from([0xff]))).toBe(createHash("sha256").update(Uint8Array.from([0xff])).digest("hex"));
  });
});
