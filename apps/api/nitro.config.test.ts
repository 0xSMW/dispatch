import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("nitro/config", () => ({ defineConfig: (config: unknown) => config }));
vi.mock("workflow/nitro", () => ({ default: {} }));

import config from "./nitro.config";

const headers = {
  "Content-Security-Policy": "frame-ancestors 'none'",
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};

const routes = config.vercel!.config!.routes!;

function matchingRoutes(path: string) {
  const matched = [];
  for (const route of routes) {
    if (!("src" in route)) continue;
    if (!new RegExp(`^${route.src}$`).test(path)) continue;
    matched.push(route);
    if (!route.continue) break;
  }
  return matched;
}

describe("dashboard deployment security headers", () => {
  it("applies headers before static files and the dashboard fallback", () => {
    const index = routes.findIndex((route) => "headers" in route);
    expect(routes[index]).toEqual({ src: "/(.*)", headers, continue: true });
    expect(routes[index + 1]).toEqual({ handle: "filesystem" });
    for (const path of ["/", "/settings", "/assets/main.js", "/favicon.svg"]) {
      expect(matchingRoutes(path)[0]).toMatchObject({
        headers,
        continue: true,
      });
    }
  });

  it("keeps API and workflow functions ahead of dashboard headers", () => {
    for (const path of [
      "/api",
      "/api/messages",
      "/.well-known/workflow/v1/flow",
      "/.well-known/workflow/v1/webhook/token",
      "/.well-known/workflow/other",
    ]) {
      const matched = matchingRoutes(path);
      expect(matched).toHaveLength(1);
      expect(matched[0]).toHaveProperty("dest");
      expect(matched[0]).not.toHaveProperty("headers");
    }
  });

  it("keeps project headers consistent and excludes function paths", () => {
    const project = JSON.parse(
      readFileSync(new URL("../../vercel.json", import.meta.url), "utf8"),
    );
    const rule = project.headers[0];
    expect(
      Object.fromEntries(
        rule.headers.map((header: { key: string; value: string }) => [
          header.key,
          header.value,
        ]),
      ),
    ).toEqual(headers);
    const source = new RegExp(`^${rule.source}$`);
    for (const path of ["/", "/settings", "/assets/main.js", "/apiary"])
      expect(source.test(path)).toBe(true);
    for (const path of [
      "/api",
      "/api/messages",
      "/.well-known/workflow/v1/flow",
    ])
      expect(source.test(path)).toBe(false);
  });
});
