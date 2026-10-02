import { describe, expect, it, vi } from "vitest";
import { checkLink, checkLinks } from "./links.js";

function reply(status: number, headers: Record<string, string> = {}) {
  return new Response(null, { status, headers });
}

const open = async () => undefined;

describe("link check", () => {
  it("reports ok, 404, and unreachable links in the order given", async () => {
    const fetch = vi.fn(async (url: URL | RequestInfo) => {
      const href = String(url);
      if (href.includes("missing")) return reply(404);
      if (href.includes("down")) throw new TypeError("fetch failed");
      return reply(200);
    }) as unknown as typeof globalThis.fetch;
    const results = await checkLinks(
      ["https://example.com/", "https://example.com/missing", "https://down.example.com/", "https://example.com/"],
      { fetch, guard: open },
    );
    expect(results.map((result) => [result.ok, result.status, result.message])).toEqual([
      [true, 200, "ok"],
      [false, 404, "404 not found"],
      [false, null, "could not be reached"],
      [true, 200, "ok"],
    ]);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect((fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][1]).toMatchObject({ method: "HEAD", redirect: "manual" });
  });

  it("runs every redirect hop through the SSRF guard", async () => {
    const guard = vi.fn(async (host: string) => {
      if (host === "169.254.169.254") throw new Error("blocked");
    });
    const fetch = vi.fn(async () => reply(302, { location: "http://169.254.169.254/latest/meta-data" })) as unknown as typeof globalThis.fetch;
    const result = await checkLink("https://example.com/go", { fetch, guard });
    expect(guard).toHaveBeenCalledWith("169.254.169.254");
    expect(result).toMatchObject({ ok: false, message: "host is not allowed" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("falls back to GET when HEAD is not allowed and rejects other schemes", async () => {
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => reply(init?.method === "HEAD" ? 405 : 200)) as unknown as typeof globalThis.fetch;
    expect(await checkLink("https://example.com/", { fetch, guard: open })).toMatchObject({ ok: true, status: 200 });
    expect(await checkLink("ftp://example.com/file", { fetch, guard: open })).toMatchObject({ ok: false, status: null });
    expect(await checkLink("not a url", { fetch, guard: open })).toMatchObject({ ok: false, message: "not a valid URL" });
  });
});
