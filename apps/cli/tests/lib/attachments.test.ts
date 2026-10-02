import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { attachments, parseSpec } from "../../src/lib/attachments.js";
import { input } from "../../src/lib/files.js";

describe("parseSpec", () => {
  it("parses a bare path", () => {
    expect(parseSpec("./invoice.pdf")).toEqual({ path: "./invoice.pdf" });
  });

  it("parses cid, type, and filename in any order", () => {
    expect(parseSpec("logo.png;type=image/png;cid=logo;filename=brand.png")).toEqual({
      path: "logo.png",
      cid: "logo",
      type: "image/png",
      filename: "brand.png",
    });
  });

  it("keeps a semicolon that is part of the path", () => {
    expect(parseSpec("report;v2.pdf")).toEqual({ path: "report;v2.pdf" });
    expect(parseSpec("report;v2.pdf;cid=r")).toEqual({ path: "report;v2.pdf", cid: "r" });
  });

  it("rejects unknown keys and an empty path", () => {
    expect(() => parseSpec("a.pdf;size=2")).toThrowError(expect.objectContaining({ code: "invalid_attachment" }));
    expect(() => parseSpec(";cid=x")).toThrowError(expect.objectContaining({ code: "invalid_attachment" }));
  });
});

describe("attachments", () => {
  const dir = mkdtempSync(join(tmpdir(), "dispatch-attach-"));
  afterEach(() => {
    input.used = false;
  });

  it("loads files as base64 with camelCase content fields", async () => {
    const file = join(dir, "logo.png");
    writeFileSync(file, "png-bytes");
    expect(await attachments([`${file};cid=logo;type=image/png`])).toEqual([
      { filename: "logo.png", content: Buffer.from("png-bytes").toString("base64"), contentType: "image/png", contentId: "logo" },
    ]);
  });

  it("applies the fallback type and appends --attachments-file entries", async () => {
    const file = join(dir, "a.txt");
    writeFileSync(file, "hi");
    const list = join(dir, "list.json");
    writeFileSync(list, JSON.stringify([{ filename: "b.txt", path: "https://example.com/b.txt" }]));
    const loaded = await attachments([file], list, "text/plain");
    expect(loaded).toEqual([
      { filename: "a.txt", content: Buffer.from("hi").toString("base64"), contentType: "text/plain" },
      { filename: "b.txt", path: "https://example.com/b.txt" },
    ]);
  });

  it("reads - from stdin, once", async () => {
    input.stdin = Readable.from([Buffer.from("from stdin")]);
    const loaded = await attachments(["-;filename=note.txt"]);
    expect(loaded?.[0]).toMatchObject({ filename: "note.txt", content: Buffer.from("from stdin").toString("base64") });
    await expect(attachments(["-"])).rejects.toMatchObject({ code: "stdin_conflict" });
  });

  it("returns undefined when there is nothing to attach", async () => {
    expect(await attachments(undefined)).toBeUndefined();
  });

  it("fails when the file is missing", async () => {
    await expect(attachments([join(dir, "nope.pdf")])).rejects.toMatchObject({ code: "file_error" });
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));
});
