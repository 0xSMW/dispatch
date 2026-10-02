import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { curl, referenceFor, references, sdk } from "./reference";

// The signed-in routes in main.tsx, read from the source so a new page cannot skip the reference.
const source = readFileSync(new URL("../main.tsx", import.meta.url), "utf8");
const publicPaths = new Set(["login", "shared", "unsubscribe", "*", "settings"]);
const routes = [...source.matchAll(/path: "([^"]+)"/g)].map((match) => match[1]!).filter((path) => !publicPaths.has(path));

describe("API reference", () => {
  it("covers every signed-in route", () => {
    expect(routes.length).toBeGreaterThan(30);
    expect(routes.filter((path) => !(`/${path}` in references))).toEqual([]);
  });

  it("fills route params into paths and SDK calls", () => {
    const reference = referenceFor("/domains/domain_9")!;
    expect(reference.title).toBe("Domain");
    expect(reference.calls[0]).toMatchObject({ method: "GET", path: "/domains/domain_9", sdk: 'dispatch.domains.get("domain_9")' });
  });

  it("prefers a static route over a param route", () => {
    expect(referenceFor("/emails/receiving")!.title).toBe("Received emails");
    expect(referenceFor("/templates/library")!.title).toBe("Template library");
    expect(referenceFor("/emails/email_1")!.title).toBe("Email");
    expect(referenceFor("/nowhere")).toBeNull();
  });

  it("writes curl with the key from the environment and a JSON body", () => {
    const call = { method: "POST" as const, path: "/segments", summary: "", sdk: null, body: { name: "O'Brien" } };
    expect(curl(call, "https://api.acme.com")).toBe(
      [
        'curl -X POST "https://api.acme.com/segments" \\',
        '  -H "Authorization: Bearer $DISPATCH_API_KEY" \\',
        '  -H "Content-Type: application/json" \\',
        `  -d '{"name":"O'\\''Brien"}'`,
      ].join("\n"),
    );
    expect(sdk(call, "https://api.acme.com")).toBeNull();
    expect(sdk({ ...call, sdk: "dispatch.segments.list()" }, "https://api.acme.com")).toContain("await dispatch.segments.list();");
  });
});
