import { describe, expect, it, vi } from "vitest";
import { templateUpdateSchema, templateVersionSchema } from "@dispatchmail/core";
import { addTemplateVersion, publishTemplate, type TemplateRecord } from "@dispatchmail/db";
import { presentTemplate, presentVersion, templateContentChanged, templateVersionSource } from "./templates.js";

const row: TemplateRecord = {
  id: "template_1",
  name: "Welcome",
  alias: "welcome",
  created_at: "2026-10-01T00:00:00.000Z",
  updated_at: "2026-10-01T00:00:00.000Z",
  status: "draft",
  published_at: null,
  current_version_id: "version_1",
  has_unpublished_versions: true,
  subject: "Hello",
  html: "<p>Hi</p>",
  text: "Hi",
  variables: [{ key: "NAME", type: "string", fallback_value: "Ada" }],
  from_address: "news@example.com",
  reply_to: ["reply@example.com"],
};

describe("presentTemplate", () => {
  it("flattens the latest version onto the template", () => {
    expect(presentTemplate(row)).toEqual({
      object: "template",
      kind: "transactional",
      id: "template_1",
      name: "Welcome",
      alias: "welcome",
      from: "news@example.com",
      reply_to: ["reply@example.com"],
      subject: "Hello",
      html: "<p>Hi</p>",
      text: "Hi",
      variables: [{ key: "NAME", type: "string", fallback_value: "Ada" }],
      status: "draft",
      published_at: null,
      published_version_id: null,
      current_version_id: "version_1",
      has_unpublished_versions: true,
      track: true,
      source: null,
      created_at: row.created_at,
      updated_at: row.updated_at,
    });
  });

  it("shows where the latest version came from and whether links are tracked", () => {
    const presented = presentTemplate({ ...row, track: false, source: { kind: "library", slug: "welcome", version: "1.0.0" } });
    expect(presented.track).toBe(false);
    expect(presented.source).toEqual({ kind: "library", slug: "welcome", version: "1.0.0" });
    expect(presentTemplate({ ...row, source: {} }).source).toBeNull();
  });
});

describe("presentVersion", () => {
  it("maps from_address to from", () => {
    expect(presentVersion({
      id: "version_1",
      subject: "Hello",
      html: null,
      text: "Hi",
      variables: [],
      from_address: "news@example.com",
      reply_to: null,
      created_at: row.created_at,
      published_at: null,
    })).toMatchObject({ from: "news@example.com", reply_to: [], subject: "Hello" });
  });
});

describe("templateContentChanged", () => {
  it("ignores name, alias, and an omitted field", () => {
    expect(templateContentChanged({ name: "Next" })).toBe(false);
    expect(templateContentChanged({ alias: null })).toBe(false);
    expect(templateContentChanged({ html: undefined })).toBe(false);
  });

  it("treats a content field as a new version", () => {
    expect(templateContentChanged({ html: "<p></p>" })).toBe(true);
    expect(templateContentChanged({ subject: "Hi" })).toBe(true);
    expect(templateContentChanged({ variables: [] })).toBe(true);
    expect(templateContentChanged({ source: { kind: "react-email", path: "emails/welcome.tsx" } })).toBe(true);
  });
});

describe("templateVersionSource", () => {
  const explicit = { ...row, source: { kind: "library", slug: "newsletter", version: "1.0.0", send_kind: "marketing" } };
  const legacy = {
    ...row,
    source: { kind: "library", slug: "newsletter", version: "1.0.0" },
    html: '<a href="{{{UNSUBSCRIBE_URL}}}">Leave</a>',
  };

  it("preserves explicit Marketing even after unsubscribe content was removed", () => {
    expect(templateVersionSource(explicit, undefined)).toEqual({ kind: "custom", send_kind: "marketing" });
    expect(templateVersionSource({ ...row, source: { kind: "custom", send_kind: "marketing" } }, undefined))
      .toEqual({ kind: "custom", send_kind: "marketing" });
  });

  it("uses existing legacy library content, not its slug or the replacement content", () => {
    expect(templateVersionSource(legacy, undefined)).toEqual({ kind: "custom", send_kind: "marketing" });
    expect(templateVersionSource({ ...legacy, html: null, text: "{{DISPATCH_UNSUBSCRIBE_URL}}" }, undefined))
      .toEqual({ kind: "custom", send_kind: "marketing" });
    expect(templateVersionSource({ ...row, source: legacy.source }, undefined)).toBeUndefined();
  });

  it("retains input provenance without mutating it or restoring library metadata", () => {
    const source = { kind: "react-email", path: "emails/tenant.tsx", send_kind: "transactional" };
    expect(templateVersionSource(legacy, source)).toEqual({
      kind: "react-email", path: "emails/tenant.tsx", send_kind: "marketing",
    });
    expect(source.send_kind).toBe("transactional");
    expect(legacy.source).toEqual({ kind: "library", slug: "newsletter", version: "1.0.0" });
  });

  it("keeps ordinary transactional edits and explicit input metadata unchanged", () => {
    expect(templateVersionSource(row, undefined)).toBeUndefined();
    expect(templateVersionSource({ ...row, source: { kind: "library", slug: "receipt" } }, undefined)).toBeUndefined();
    const source = { kind: "custom", send_kind: "marketing" };
    expect(templateVersionSource(row, source)).toBe(source);
    // Content-only intent on a non-library source is not a sticky library declaration.
    expect(templateVersionSource({ ...legacy, source: { kind: "custom" } }, undefined)).toBeUndefined();
  });

  // Exercise the real version-write/publication functions with captured SQL parameters.
  // This is not an HTTP or PostgreSQL integration fixture; those belong to the supervisor.
  it.each([
    ["explicit Marketing POST", explicit, false],
    ["explicit Marketing PATCH", explicit, true],
    ["legacy Marketing POST", legacy, false],
    ["legacy Marketing PATCH", legacy, true],
    ["ordinary transactional POST", row, false],
    ["ordinary transactional PATCH", row, true],
  ] as const)("retains exact tenant content through %s and publication", async (_name, current, patch) => {
    const replacement = {
      subject: "Tenant subject",
      html: '<p data-tenant="yes">Tenant &amp; replacement</p>',
      text: "Tenant & replacement",
    };
    const input = patch ? templateUpdateSchema.parse(replacement) : templateVersionSchema.parse(replacement);
    let stored: TemplateRecord = { ...current };
    const query = vi.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.includes("as live")) {
        return { rows: [{ id: stored.current_version_id, published_at: null, live: false }] };
      }
      if (sql.includes("insert into template_versions")) {
        stored = {
          ...stored,
          current_version_id: String(params[0]),
          subject: params[3] as string,
          html: params[4] as string,
          text: params[5] as string,
          source: JSON.parse(params[9] as string),
        };
      }
      if (sql.includes("set subject = $3")) {
        stored = {
          ...stored,
          subject: params[2] as string,
          html: params[3] as string,
          text: params[4] as string,
          source: JSON.parse(params[8] as string),
        };
      }
      if (sql.includes("set published_version_id")) {
        stored = {
          ...stored, status: "published", published_version_id: String(params[2]),
          published_at: row.created_at, has_unpublished_versions: false,
        };
      }
      if (sql.includes("current_version_id")) return { rows: [stored] };
      if (sql.includes("select id, subject, html, text from template_versions")) {
        return { rows: [{ ...stored, id: stored.current_version_id }] };
      }
      return { rows: [] };
    });
    const draft = await addTemplateVersion({ query }, "tenant_1", row.id, {
      name: row.name,
      ...input,
      source: templateVersionSource(current, input.source),
    }, patch ? { reuseDraft: true } : {});
    const expectedSource = current === row ? {} : { kind: "custom", send_kind: "marketing" };
    expect(draft).toMatchObject({ ...replacement, source: expectedSource });
    expect(query.mock.calls.some(([sql]) => sql.includes("set subject = $3"))).toBe(patch);
    const published = await publishTemplate({ query }, "tenant_1", row.id, draft.current_version_id);
    expect(published).toMatchObject({
      ...replacement, source: expectedSource, status: "published",
      published_version_id: draft.current_version_id,
    });
    expect(presentTemplate(published).kind).toBe(current === row ? "transactional" : "marketing");
    expect(query.mock.calls.find(([sql]) => sql.includes("set published_version_id"))?.[1])
      .toEqual(["tenant_1", row.id, draft.current_version_id]);
  });
});
