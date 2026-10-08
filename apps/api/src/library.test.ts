import * as fs from "node:fs/promises";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { ApiError, brandContext } from "@dispatchmail/core";
import { installLibraryTemplate, libraryEntry, listLibrary, loadLibrary, previewLibrary, type LibraryFile } from "./library.js";

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

const library: LibraryFile = {
  version: "1.0.0",
  automations: [],
  templates: [
    {
      slug: "password-reset",
      name: "Password reset",
      category: "authentication",
      kind: "transactional",
      stage: null,
      when: "Send after a password reset request.",
      track: false,
      subject: "Reset your {{{PRODUCT_NAME}}} password",
      description: "Sent when someone asks to reset their password.",
      variables: [
        { key: "ACTION_URL", type: "string", fallback_value: null },
        { key: "RECIPIENT_NAME", type: "string", fallback_value: "there" },
      ],
      sample: { ACTION_URL: "https://example.com/reset" },
      html: `<p>Hi {{{RECIPIENT_NAME}}}, <a href="{{{ACTION_URL}}}">Reset password</a></p>`,
      text: "Hi {{{RECIPIENT_NAME}}}",
    },
  ],
};

describe("template library", () => {
  it("loads the built-in catalog without reading a runtime file", async () => {
    const read = vi.mocked(fs.readFile).mockRejectedValue(new Error("No repository files in the serverless runtime"));
    try {
      const catalog = await loadLibrary();
      expect(catalog.templates).toHaveLength(25);
      expect(catalog.automations.length).toBeGreaterThan(0);
      expect(read).not.toHaveBeenCalled();
    } finally {
      read.mockReset();
      read.mockImplementation((await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")).readFile);
    }
  });

  it("lists the manifest without the html and text bodies", () => {
    const listed = listLibrary(library);
    expect(listed.object).toBe("list");
    expect(listed.data[0]).toMatchObject({ slug: "password-reset", track: false, stage: null, when: "Send after a password reset request." });
    expect(listed.data[0]).not.toHaveProperty("html");
    expect(listed.data[0]).not.toHaveProperty("text");
    expect(listed.data[0]).not.toHaveProperty("preview_html");
  });

  it("renders a preview from the sample and the brand", () => {
    const entry = libraryEntry(library, "password-reset");
    const preview = previewLibrary(entry, { PRODUCT_NAME: "Acme" });
    expect(preview.object).toBe("template_library");
    expect(preview.rendered.subject).toBe("Reset your Acme password");
    expect(preview.rendered.html).toContain("Hi there");
    expect(preview.rendered.html).toContain("https://example.com/reset");
    // The inbox preview text keeps its own field beside the rendered sample.
    expect(preview.preview).toBe(entry.preview);
    expect(preview).not.toHaveProperty("html");
    expect(preview).toMatchObject({ stage: null, when: "Send after a password reset request." });
  });

  it("previews every template in the real library for a tenant with no brand set", async () => {
    const real = await loadLibrary();
    expect(real.templates).toHaveLength(25);
    // What previewBrand() gives a new tenant: a name and nothing else.
    const brand = brandContext({}, { tenantName: "Acme", domain: "example.com", from: "support@example.com" });
    for (const entry of real.templates) {
      const preview = previewLibrary(entry, brand);
      expect(preview.rendered.html, entry.slug).toBeTruthy();
      expect(preview.rendered.html, entry.slug).not.toContain("{{{");
    }
    expect(previewLibrary(libraryEntry(real, "newsletter"), brand).rendered.html).toContain("https://example.com/unsubscribe");
    expect(listLibrary(real).data.find((entry) => entry.slug === "newsletter-welcome")).toMatchObject({
      stage: "acquisition", kind: "marketing", when: expect.any(String),
    });
  });

  it("names a missing slug", () => {
    expect(() => libraryEntry(library, "missing")).toThrow(ApiError);
  });

  it("installs one published library template and refuses a different kind", async () => {
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    const db = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params });
        if (sql.includes("current_version_id")) {
          return { rows: [{ id: "template_reset", name: "Password reset", alias: "password-reset", status: "published" }] };
        }
        if (sql.includes("select t.id, latest.source")) return { rows: [] };
        if (sql.includes("select id from templates")) return { rows: [{ id: "template_reset" }] };
        return { rows: [] };
      }),
    };
    const installed = await installLibraryTemplate(db, "tenant_1", library, "password-reset");
    expect(installed).toEqual({ object: "template", id: "template_reset" });
    const version = calls.find((call) => call.sql.includes("insert into template_versions"));
    expect(version?.params?.[9]).toBe(JSON.stringify({ kind: "library", slug: "password-reset", version: "1.0.0", send_kind: "transactional" }));
    expect(calls.some((call) => call.sql.includes("set published_version_id"))).toBe(true);

    const taken = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("select t.id, latest.source")) return { rows: [{ id: "template_1", source: { kind: "react-email" } }] };
        return { rows: [] };
      }),
    };
    await expect(installLibraryTemplate(taken, "tenant_1", library, "password-reset")).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it("reads a library file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dispatch-library-"));
    try {
      const file = join(dir, "library.json");
      await writeFile(file, JSON.stringify(library));
      const loaded = await loadLibrary(pathToFileURL(file));
      expect(loaded.templates[0]?.slug).toBe("password-reset");
      const again = await loadLibrary(pathToFileURL(file));
      expect(again).toBe(loaded);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
