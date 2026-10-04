import { describe, expect, it } from "vitest";
import { presentTemplate, presentVersion, templateContentChanged } from "./templates.js";
import type { TemplateRecord } from "@dispatchmail/db";

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
