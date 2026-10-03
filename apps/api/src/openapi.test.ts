import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Keeps docs/api/openapi.json in step with the routes the API registers. Reads the route modules
// as text, so it needs no database and never boots the server.

const src = new URL("./", import.meta.url);
const spec = JSON.parse(readFileSync(new URL("../../../docs/api/openapi.json", import.meta.url), "utf8")) as {
  paths: Record<string, Record<string, unknown>>;
};

const methods = ["get", "post", "patch", "put", "delete"];

// Fastify paths to OpenAPI paths: `:id` becomes `{id}`, `/open/:token.gif` becomes
// `/open/{token}.gif`, and the `/files/*` wildcard is the signed token.
function openApiPath(path: string) {
  return path.replace(/:([A-Za-z_]+)/g, "{$1}").replace(/\/\*$/, "/{token}");
}

// Matches `app.get("/x", ...)` and `scope.post(\n  "/x",` in a route module.
function routesIn(source: string) {
  const pattern = /\b(?:app|scope)\.(get|post|patch|put|delete)\(\s*["'`]([^"'`]+)["'`]/g;
  return [...source.matchAll(pattern)].map((match) => `${match[1]} ${openApiPath(match[2])}`);
}

function codeRoutes() {
  const files = readdirSync(src).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"));
  return files.flatMap((name) => routesIn(readFileSync(new URL(name, src), "utf8")));
}

function documentedRoutes() {
  return Object.entries(spec.paths).flatMap(([path, item]) =>
    Object.keys(item)
      .filter((key) => methods.includes(key))
      .map((method) => `${method} ${path}`),
  );
}

function refs(value: unknown, found: string[] = []) {
  if (Array.isArray(value)) for (const item of value) refs(item, found);
  else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (key === "$ref" && typeof child === "string") found.push(child);
      else refs(child, found);
    }
  }
  return found;
}

function resolves(pointer: string) {
  if (!pointer.startsWith("#/")) return false;
  let node: unknown = spec;
  for (const part of pointer.slice(2).split("/")) {
    const key = part.replaceAll("~1", "/").replaceAll("~0", "~");
    if (!node || typeof node !== "object" || !(key in node)) return false;
    node = (node as Record<string, unknown>)[key];
  }
  return true;
}

describe("route extraction", () => {
  it("reads single-line and split calls on app and scope", () => {
    const source = `app.get("/a/:id", h);\napp.post(\n  "/b",\n  { config: { scope: "send" } },\n  h);\nscope.delete("/c/:id/d/:d_id", h);`;
    expect(routesIn(source)).toEqual(["get /a/{id}", "post /b", "delete /c/{id}/d/{d_id}"]);
  });

  it("converts Fastify paths", () => {
    expect(openApiPath("/open/:token.gif")).toBe("/open/{token}.gif");
    expect(openApiPath("/files/*")).toBe("/files/{token}");
    expect(openApiPath("/emails/:id/attachments/:attachment_id")).toBe("/emails/{id}/attachments/{attachment_id}");
  });
});

describe("docs/api/openapi.json", () => {
  const code = codeRoutes();
  const documented = documentedRoutes();

  it("finds the registered routes", () => {
    expect(code.length).toBeGreaterThan(100);
    expect(new Set(code).size).toBe(code.length);
  });

  it("documents every route the code registers", () => {
    expect(code.filter((route) => !documented.includes(route))).toEqual([]);
  });

  it("documents no route the code lacks", () => {
    expect(documented.filter((route) => !code.includes(route))).toEqual([]);
  });

  it("has no /v1 paths", () => {
    expect(Object.keys(spec.paths).filter((path) => path.startsWith("/v1"))).toEqual([]);
  });

  it("keeps deployment callbacks separate from tenant bearer authentication", () => {
    expect(spec.paths["/internal/reconcile"].get).toMatchObject({
      tags: ["Internal"],
      security: [{ cronAuth: [] }],
    });
    expect(spec.paths["/internal/events"].post).toMatchObject({
      tags: ["Internal"],
      security: [],
      responses: { "503": { description: expect.stringContaining("Retry") } },
    });
  });

  it("resolves every $ref", () => {
    expect(refs(spec).filter((pointer) => !resolves(pointer))).toEqual([]);
  });

  it("gives every operation an operationId, a summary, and a tag", () => {
    const operations = Object.values(spec.paths).flatMap((item) =>
      Object.entries(item)
        .filter(([key]) => methods.includes(key))
        .map(([, operation]) => operation as { operationId?: string; summary?: string; tags?: string[] }),
    );
    expect(operations.filter((operation) => !operation.operationId || !operation.summary || !operation.tags?.length)).toEqual([]);
    const ids = operations.map((operation) => operation.operationId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
