import { describe, expect, it, vi } from "vitest";
import { updateLibraryTemplates } from "./library-updates.js";
import type { LibraryInstallEntry } from "./templates.js";

const entry: LibraryInstallEntry = {
  slug: "welcome", name: "Welcome", subject: "New subject", html: "<p>New library</p>",
  text: "New library", kind: "transactional", track: true,
  variables: [{ key: "NAME", type: "string", fallback_value: "friend" }, { key: "NEW", type: "string", fallback_value: "" }],
};
function mockDb(options: { source?: Record<string, unknown>; published?: string | null; alias?: string; html?: string } = {}) {
  const query = vi.fn(async (sql: string, values: unknown[]) => {
    if (sql.includes("as library_slug")) return { rows: [{
      id: "template_1", name: "My welcome", alias: options.alias ?? "welcome",
      published_version_id: options.published === undefined ? "version_old" : options.published, library_slug: "welcome",
    }] };
    if (sql.includes("for update of v")) return { rows: [{
      id: "version_old", source: options.source ?? { kind: "library", slug: "welcome", version: "old" },
      variables: [{ key: "NAME", type: "string", fallback_value: "tenant fallback" }, { key: "TENANT", type: "number", fallback_value: 0 }],
      from_address: "Team <team@example.com>", reply_to: ["reply@example.com"], html: options.html ?? "<p>Old HTML</p>", text: "Old text",
    }] };
    if (sql.includes("current_version_id")) return { rows: [{ id: values[1] }] };
    return { rows: [] };
  });
  return { query };
}

describe("explicit library updates", () => {
  it("adds a version under tenant locks, preserving sending settings and tenant declarations", async () => {
    const db = mockDb();
    expect(await updateLibraryTemplates(db, "tenant_1", [entry], "9")).toEqual({
      updated: [{ id: "template_1", name: "My welcome", slug: "welcome" }], skipped: [],
    });
    expect(db.query.mock.calls[0]![0]).toContain("for update of t");
    expect(db.query.mock.calls[0]![1]).toEqual(["tenant_1", ["welcome"]]);
    expect(db.query.mock.calls[1]![0]).toContain("v.tenant_id = $1");
    expect(db.query.mock.calls[1]![0]).toContain("order by v.created_at desc, v.id desc");
    const insert = db.query.mock.calls.find(([sql]) => sql.includes("insert into template_versions"))!;
    expect(insert[1].slice(1, 6)).toEqual(["tenant_1", "template_1", entry.subject, entry.html, entry.text]);
    expect(JSON.parse(insert[1][6] as string)).toEqual([
      { key: "NAME", type: "string", fallback_value: "tenant fallback" },
      { key: "TENANT", type: "number", fallback_value: 0 }, { key: "NEW", type: "string", fallback_value: "" },
    ]);
    expect(insert[1][7]).toBe("Team <team@example.com>");
    expect(JSON.parse(insert[1][8] as string)).toEqual(["reply@example.com"]);
    expect(JSON.parse(insert[1][9] as string)).toMatchObject({ kind: "library", slug: "welcome", version: "9", send_kind: "transactional" });
    expect(db.query.mock.calls.some(([sql]) => sql.includes("set track"))).toBe(false);
    expect(db.query.mock.calls.some(([sql]) => sql.includes("set published_version_id"))).toBe(true);
    expect(db.query.mock.calls.some(([sql]) => sql.includes("insert into templates"))).toBe(false);
  });

  it.each([{ kind: "custom", slug: "welcome" }, { kind: "library", slug: "other" }, {}])(
    "skips an edited or mismatched latest source %j", async (source) => {
      const db = mockDb({ source });
      const result = await updateLibraryTemplates(db, "tenant_1", [entry]);
      expect(result.updated).toEqual([]);
      expect(result.skipped).toEqual([{ id: "template_1", name: "My welcome", slug: "welcome", reason: expect.any(String) }]);
      expect(db.query).toHaveBeenCalledTimes(2);
    },
  );

  it.each([null, "previous_live_version"])("does not publish a draft with published pointer %s", async (published) => {
    const db = mockDb({ published });
    await updateLibraryTemplates(db, "tenant_1", [entry]);
    expect(db.query.mock.calls.find(([sql]) => sql.includes("insert into template_versions"))![0]).toContain("null, clock_timestamp())");
    expect(db.query.mock.calls.some(([sql]) => sql.includes("set published_version_id"))).toBe(false);
  });

  it.each([
    { source: { kind: "library", slug: "welcome", send_kind: "marketing" } },
    { html: '<a href="{{{UNSUBSCRIBE_URL}}}">Unsubscribe</a>' },
  ])("preserves marketing intent, including legacy installed HTML %j", async (options) => {
    const db = mockDb({ ...options, alias: "renamed" });
    await updateLibraryTemplates(db, "tenant_1", [entry]);
    const insert = db.query.mock.calls.find(([sql]) => sql.includes("insert into template_versions"))!;
    expect(JSON.parse(insert[1][9] as string).send_kind).toBe("marketing");
  });

  it("does not install missing catalog entries or query for an empty catalog", async () => {
    const db = { query: vi.fn(async () => ({ rows: [] })) };
    expect(await updateLibraryTemplates(db, "tenant_1", [])).toEqual({ updated: [], skipped: [] });
    expect(db.query).not.toHaveBeenCalled();
    expect(await updateLibraryTemplates(db, "tenant_1", [entry])).toEqual({ updated: [], skipped: [] });
    expect(db.query).toHaveBeenCalledTimes(1);
  });
});
