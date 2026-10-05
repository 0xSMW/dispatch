import { describe, expect, it, vi } from "vitest";
import { ApiError } from "@dispatchmail/core";
import { addTemplateVersion, createTemplate, installLibrary, installLibraryMissing, listTemplateVersions, publishTemplate, templateDetail, updateTemplateMeta } from "./templates.js";

function memoryDb() {
  const sqls: string[] = [];
  const query = vi.fn(async (sql: string) => {
    sqls.push(sql);
    if (sql.includes("current_version_id")) {
      return {
        rows: [{
          id: "template_1",
          name: "Welcome",
          alias: "welcome",
          status: sql.includes("published_version_id = $3") ? "published" : "draft",
          subject: "Hello",
          html: null,
          text: "Hi",
          variables: [],
          from_address: null,
          reply_to: [],
          current_version_id: "version_1",
          has_unpublished_versions: true,
          published_at: null,
          created_at: "2026-10-01T00:00:00.000Z",
          updated_at: "2026-10-01T00:00:00.000Z",
        }],
      };
    }
    return { rows: [] };
  });
  return { query, sqls };
}

describe("templates", () => {
  it("publishes a missing alias only for the winning insert", async () => {
    const query = vi.fn(async (sql: string, values: unknown[]) =>
      ({ rows: sql.includes("do nothing returning id") ? [{ id: values[0] }] : [] }));
    const result = await installLibraryMissing({ query }, "tenant_1", {
      slug: "welcome", name: "Welcome", subject: "Hello", html: "<p>Hello</p>", kind: "transactional",
    });
    expect(result).toEqual({ id: expect.stringMatching(/^template_/), created: true });
    expect(query.mock.calls[0]![0]).toContain("on conflict (tenant_id, alias)");
    expect(query.mock.calls.filter(([sql]) => sql.includes("insert into template_versions"))).toHaveLength(1);
    expect(query.mock.calls.filter(([sql]) => sql.includes("set published_version_id"))).toHaveLength(1);
  });

  it("reuses a concurrent alias without writing content, versions or publication", async () => {
    const query = vi.fn(async (sql: string) => ({ rows: sql.startsWith("select t.id") ? [{ id: "template_edited" }] : [] }));
    expect(await installLibraryMissing({ query }, "tenant_1", {
      slug: "welcome", name: "Welcome", subject: "Library", html: "<p>Library</p>",
    })).toEqual({ id: "template_edited", created: false });
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1]![0]).toContain("for update of t");
    expect(query.mock.calls[1]![1]).toEqual(["tenant_1", "welcome"]);
  });

  it("conflicts rather than repairing a disappeared or unusable alias winner", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    await expect(installLibraryMissing({ query }, "tenant_1", {
      slug: "welcome", name: "Welcome", subject: "Library", html: "<p>Library</p>",
    })).rejects.toMatchObject({ name: "conflict", statusCode: 409 });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("looks up a template by id or alias", async () => {
    const db = memoryDb();
    const row = await templateDetail(db, "tenant_1", "welcome");
    expect(row.id).toBe("template_1");
    expect(db.sqls[0]).toContain("t.id = $2 or t.alias = $2");
    expect(db.query.mock.calls[0][1]).toEqual(["tenant_1", "welcome"]);
  });

  it("creates a draft unless publish is set", async () => {
    const draft = memoryDb();
    await createTemplate(draft, "tenant_1", { name: "Welcome", alias: "welcome", subject: "Hello", text: "Hi" });
    const inserted = draft.sqls.find((sql) => sql.includes("insert into template_versions"));
    expect(inserted).toContain("null)");
    expect(draft.sqls.some((sql) => sql.includes("set published_version_id"))).toBe(false);

    const published = memoryDb();
    await createTemplate(published, "tenant_1", { name: "Welcome", subject: "Hello", text: "Hi", publish: true });
    expect(published.sqls.some((sql) => sql.includes("now()"))).toBe(true);
    expect(published.sqls.some((sql) => sql.includes("set published_version_id"))).toBe(true);
  });

  it("stores from and reply_to on the version", async () => {
    const db = memoryDb();
    await createTemplate(db, "tenant_1", {
      name: "Welcome",
      subject: "Hello",
      text: "Hi",
      from: "news@example.com",
      reply_to: ["reply@example.com"],
    });
    const insert = db.query.mock.calls.find((call) => String(call[0]).includes("insert into template_versions"));
    expect(insert?.[1]).toEqual([
      expect.stringMatching(/^version_/),
      "tenant_1",
      expect.stringMatching(/^template_/),
      "Hello",
      null,
      "Hi",
      "[]",
      "news@example.com",
      JSON.stringify(["reply@example.com"]),
      "{}",
    ]);
  });

  it("adds an unpublished version unless publish is set", async () => {
    const draft = memoryDb();
    await addTemplateVersion(draft, "tenant_1", "template_1", { name: "Welcome", subject: "Next", html: "<p>Next</p>" });
    expect(draft.sqls.find((sql) => sql.includes("insert into template_versions"))).toContain("null)");
    expect(draft.sqls.some((sql) => sql.includes("set published_version_id"))).toBe(false);

    const published = memoryDb();
    await addTemplateVersion(published, "tenant_1", "template_1", { name: "Welcome", subject: "Next", text: "Next", publish: true });
    expect(published.sqls.some((sql) => sql.includes("set published_version_id"))).toBe(true);
  });

  it("publishes the requested version", async () => {
    const db = memoryDb();
    db.query.mockImplementation(async (sql: string) => {
      db.sqls.push(sql);
      if (sql.includes("current_version_id")) return { rows: [{ id: "template_1", name: "Welcome", status: "published" }] };
      if (sql.includes("from template_versions") && sql.includes("select id")) return { rows: [{ id: "version_9" }] };
      return { rows: [] };
    });
    await publishTemplate(db, "tenant_1", "welcome", "version_9");
    const marked = db.query.mock.calls.find((call) => String(call[0]).includes("set published_version_id"));
    expect(marked?.[1]).toEqual(["tenant_1", "template_1", "version_9"]);
  });

  it("rejects a publish when the version is missing", async () => {
    const db = memoryDb();
    await expect(publishTemplate(db, "tenant_1", "welcome")).rejects.toThrow(ApiError);
  });

  it("distinguishes an omitted alias from a cleared alias", async () => {
    const db = memoryDb();
    await updateTemplateMeta(db, "tenant_1", "template_1", { name: "Renamed" });
    await updateTemplateMeta(db, "tenant_1", "template_1", { alias: null });
    expect(db.query.mock.calls[0][1]).toEqual(["tenant_1", "template_1", "Renamed", false, null]);
    expect(db.query.mock.calls[1][1]).toEqual(["tenant_1", "template_1", null, true, null]);
  });

  it("publishes a library template and will not replace another kind", async () => {
    const created = memoryDb();
    await installLibrary(created, "tenant_1", [{ slug: "welcome", name: "Welcome", subject: "Hi", html: "<p>Hi</p>", track: false }]);
    const insert = created.query.mock.calls.find((call) => String(call[0]).includes("insert into templates"));
    expect(insert?.[1]?.[3]).toBe("welcome");
    expect(insert?.[1]?.[4]).toBe(false);
    expect(created.sqls.some((sql) => sql.includes("set published_version_id"))).toBe(true);

    const taken = memoryDb();
    taken.query.mockImplementation(async (sql: string) => {
      if (sql.includes("latest.source")) return { rows: [{ id: "template_1", source: { kind: "react-email" } }] };
      return { rows: [] };
    });
    await expect(installLibrary(taken, "tenant_1", [{ slug: "welcome", name: "Welcome", subject: "Hi", html: "<p></p>" }])).rejects.toThrow(ApiError);
  });

  it("writes over a never-published latest version when asked, and adds one otherwise", async () => {
    const withDraft = memoryDb();
    const base = withDraft.query.getMockImplementation()!;
    withDraft.query.mockImplementation(async (sql: string) => {
      if (sql.includes("as live")) {
        withDraft.sqls.push(sql);
        return { rows: [{ id: "version_draft", published_at: null, live: false }] };
      }
      return base(sql);
    });
    await addTemplateVersion(withDraft, "tenant_1", "template_1", { name: "Welcome", html: "<p>2</p>" }, { reuseDraft: true });
    const update = withDraft.query.mock.calls.find((call) => String(call[0]).includes("update template_versions"));
    expect((update?.[1] as unknown[])[1]).toBe("version_draft");
    expect(withDraft.sqls.some((sql) => sql.includes("insert into template_versions"))).toBe(false);

    const published = memoryDb();
    const publishedBase = published.query.getMockImplementation()!;
    published.query.mockImplementation(async (sql: string) => {
      if (sql.includes("as live")) return { rows: [{ id: "version_live", published_at: "2026-10-01T00:00:00.000Z", live: true }] };
      return publishedBase(sql);
    });
    await addTemplateVersion(published, "tenant_1", "template_1", { name: "Welcome", html: "<p>2</p>" }, { reuseDraft: true });
    expect(published.sqls.some((sql) => sql.includes("insert into template_versions"))).toBe(true);

    const always = memoryDb();
    await addTemplateVersion(always, "tenant_1", "template_1", { name: "Welcome", html: "<p>2</p>" });
    expect(always.sqls.some((sql) => sql.includes("as live"))).toBe(false);
    expect(always.sqls.some((sql) => sql.includes("insert into template_versions"))).toBe(true);
  });

  it("stamps the publish time on every publish, also for an earlier version", async () => {
    const db = memoryDb();
    const base = db.query.getMockImplementation()!;
    db.query.mockImplementation(async (sql: string) => {
      if (sql.includes("from template_versions") && sql.includes("select id")) return { rows: [{ id: "version_1" }] };
      return base(sql);
    });
    await publishTemplate(db, "tenant_1", "welcome", "version_1");
    expect(db.sqls.some((sql) => sql.includes("set published_at = now()"))).toBe(true);
  });

  it("refuses to publish a version whose blocks do not balance, and still saves it as a draft", async () => {
    const draft = memoryDb();
    await createTemplate(draft, "tenant_1", { name: "Welcome", subject: "Hi", html: "{{{#if NAME}}}open" });
    expect(draft.sqls.some((sql) => sql.includes("insert into template_versions"))).toBe(true);

    const published = memoryDb();
    await expect(
      createTemplate(published, "tenant_1", { name: "Welcome", subject: "Hi", html: "{{{#if NAME}}}open", publish: true }),
    ).rejects.toMatchObject({ statusCode: 422, message: "html: Template block {{{#if NAME}}} is never closed" });
    expect(published.sqls).toEqual([]);

    const stored = memoryDb();
    const base = stored.query.getMockImplementation()!;
    stored.query.mockImplementation(async (sql: string) => {
      if (sql.includes("from template_versions") && sql.includes("select id")) {
        return { rows: [{ id: "version_1", subject: "Hi", html: null, text: "{{{/each}}}" }] };
      }
      return base(sql);
    });
    await expect(publishTemplate(stored, "tenant_1", "welcome")).rejects.toMatchObject({ statusCode: 422 });
    expect(stored.sqls.some((sql) => sql.includes("set published_version_id"))).toBe(false);
  });

  it("lists versions newest first", async () => {
    const db = memoryDb();
    db.query.mockImplementation(async (sql: string) => {
      db.sqls.push(sql);
      return { rows: [{ id: "version_2" }, { id: "version_1" }] };
    });
    const rows = await listTemplateVersions(db, "tenant_1", "template_1");
    expect(rows.map((row) => row.id)).toEqual(["version_2", "version_1"]);
    expect(String(db.query.mock.calls[0][0])).toContain("order by created_at desc, id desc");
    expect(db.query.mock.calls[0][1]).toEqual(["tenant_1", "template_1"]);
  });
});
