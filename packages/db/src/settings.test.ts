import { describe, expect, it, vi } from "vitest";
import { settingsSchema, settingsUpdateSchema } from "@dispatchmail/core";
import type { Queryable } from "./index.js";
import { settings, updateSettings } from "./settings.js";

describe("tenant settings", () => {
  it("defaults imports off and sandbox additions to empty", () => {
    expect(settingsSchema.parse({})).toEqual({ import_trigger_automations: false, sandbox_domains: [] });
  });

  it("validates and normalizes hostnames, caps additions, and refuses unknown keys", () => {
    expect(settingsSchema.parse({ sandbox_domains: [" Demo.TEST "] }).sandbox_domains).toEqual(["demo.test"]);
    expect(settingsSchema.safeParse({ sandbox_domains: ["https://example.test"] }).success).toBe(false);
    expect(settingsSchema.safeParse({ sandbox_domains: Array(51).fill("example.test") }).success).toBe(false);
    expect(settingsSchema.safeParse({ unrelated: true }).success).toBe(false);
    expect(settingsUpdateSchema.parse({ sandbox_domains: [] })).toEqual({ sandbox_domains: [] });
  });

  it("reads the effective settings for only the requested tenant", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ settings: {} }] });
    expect(await settings({ query } as unknown as Queryable, "tenant_1")).toEqual(settingsSchema.parse({}));
    expect(query.mock.calls[0]![1]).toEqual(["tenant_1"]);
  });

  it("atomically patches only supplied keys", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ settings: { import_trigger_automations: true, sandbox_domains: ["demo.test"] } }] });
    const result = await updateSettings({ query } as unknown as Queryable, "tenant_1", { sandbox_domains: ["demo.test"] });
    expect(result.import_trigger_automations).toBe(true);
    expect(query.mock.calls[0]![1]).toEqual(["tenant_1", JSON.stringify({ sandbox_domains: ["demo.test"] })]);
  });

  it("refuses a missing tenant", async () => {
    const db = { query: vi.fn().mockResolvedValue({ rows: [] }) } as unknown as Queryable;
    await expect(settings(db, "missing")).rejects.toMatchObject({ statusCode: 404 });
  });
});
