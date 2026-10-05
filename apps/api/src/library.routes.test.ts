import { readFileSync } from "node:fs";
import Fastify from "fastify";
import { ApiError } from "@dispatchmail/core";
import { describe, expect, it, vi } from "vitest";
import { presets } from "../../../packages/templates/src/presets";
import { permitted } from "./platform.js";
import { loadLibrary, registerLibraryAutomations } from "./library.js";

const writes = vi.hoisted(() => vi.fn(() => { throw new Error("Preset reads must not install templates"); }));
const installer = vi.hoisted(() => vi.fn());
const transaction = vi.hoisted(() => vi.fn(async (_db: unknown, run: (client: unknown) => unknown) => run({ query: () => ({ rows: [] }) })));
vi.mock("@dispatchmail/db", async (original) => ({
  ...await original<typeof import("@dispatchmail/db")>(),
  installLibrary: writes,
  installAutomation: installer,
  tx: transaction,
}));

async function harness(permissions: string[] = ["full"], scope = "full", install = false) {
  const library = await loadLibrary();
  const load = vi.fn(async () => library);
  const app = Fastify();
  // Use the production permission predicate without booting services/auth storage.
  app.addHook("preHandler", async (request) => {
    Object.assign(request, { auth: { tenant_id: "tenant_1", permissions } });
    if (scope !== "full") throw new ApiError("restricted_api_key", 401, "Full access key required");
    if (!permitted(permissions, request.method, request.routeOptions.url ?? request.url)) {
      throw new ApiError("forbidden", 403, "Full permission required");
    }
  });
  app.setErrorHandler((error: Error & { statusCode?: number }, _request, reply) =>
    reply.status(error.name === "ZodError" ? 400 : error.statusCode ?? 500).send({ name: error.name === "ZodError" ? "validation_error" : error.name, message: error.message }));
  registerLibraryAutomations(app, load, install ? {} as import("@dispatchmail/db").Db : undefined);
  // The production template preview has this wildcard: static preset routes win.
  app.get("/template-library/:slug", async () => ({ object: "template_library" }));
  return { app, load, library };
}

describe("automation preset read routes", () => {
  it.each(["full", "read"])("returns all six unchanged definitions to the %s role without paging or writes", async (role) => {
    const { app, load, library } = await harness([role]);
    const before = JSON.stringify(library);
    try {
      const response = await app.inject({ method: "GET", url: "/template-library/automations?limit=1&after=ignored" });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ object: "list", has_more: false, data: presets });
      expect(response.json().data).toHaveLength(6);
      expect(load).toHaveBeenCalledTimes(1);
      expect(writes).not.toHaveBeenCalled();
      expect(JSON.stringify(library)).toBe(before);
    } finally {
      await app.close();
    }
  });

  it.each(presets)("returns the exact $slug detail envelope with library-slug references", async (preset) => {
    const { app } = await harness(["read"]);
    try {
      const response = await app.inject({ method: "GET", url: `/template-library/automations/${preset.slug}` });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ object: "automation_preset", ...preset });
      expect(Object.keys(response.json()).sort()).toEqual(["object", ...Object.keys(preset)].sort());
      for (const step of response.json().steps.filter((step: { type: string }) => step.type === "send_email")) {
        expect(typeof step.config.template).toBe("string");
        expect(step.config).not.toHaveProperty("from");
        expect(step.config).not.toHaveProperty("topic_id");
      }
      expect(writes).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("preserves the newsletter install topic placeholder and approved yes/no Condition", async () => {
    const { app } = await harness();
    try {
      const response = await app.inject("/template-library/automations/newsletter-welcome");
      expect(response.json().trigger_config).toEqual({ type: "topic_subscribed", topic_id: "{{topic_id}}" });
      expect(response.json().steps.find((step: { key: string }) => step.key === "activation").type).toBe("condition");
    } finally {
      await app.close();
    }
  });

  it("returns the existing not_found error for an unknown preset", async () => {
    const { app } = await harness();
    try {
      const response = await app.inject("/template-library/automations/missing");
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ name: "not_found", message: "Automation preset not found" });
    } finally {
      await app.close();
    }
  });

  it.each([
    { permissions: [], scope: "full", status: 403, name: "forbidden" },
    { permissions: ["full"], scope: "send", status: 401, name: "restricted_api_key" },
  ])("inherits permission/key restrictions for $scope/$permissions", async ({ permissions, scope, status, name }) => {
    const { app, load } = await harness(permissions, scope);
    try {
      for (const url of ["/template-library/automations", "/template-library/automations/failed-payment"]) {
        const response = await app.inject(url);
        expect(response.statusCode).toBe(status);
        expect(response.json().name).toBe(name);
      }
      expect(load).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("does not ship a write or installer route", async () => {
    const { app, load } = await harness();
    try {
      for (const url of ["/template-library/automations", "/template-library/automations/onboarding-drip/install"]) {
        expect((await app.inject({ method: "POST", url, payload: {} })).statusCode).toBe(404);
      }
      expect(load).not.toHaveBeenCalled();
      expect(writes).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("is wired into the existing server without bypassing global authentication", () => {
    const source = readFileSync(new URL("./server.ts", import.meta.url), "utf8");
    expect(source).toContain("registerLibraryAutomations(app, loadLibrary, db);");
    expect(source).toContain("await authenticate(request);");
    expect(source).toContain('permitted(request.auth!.permissions ?? [], request.method, request.routeOptions.url ?? path)');
  });
});

describe("automation preset OpenAPI", () => {
  const spec = JSON.parse(readFileSync(new URL("../../../docs/api/openapi.json", import.meta.url), "utf8"));

  it("documents only the shipped full-key GET endpoints and their envelopes", () => {
    const list = spec.paths["/template-library/automations"];
    const detail = spec.paths["/template-library/automations/{slug}"];
    expect(Object.keys(list)).toEqual(["get"]);
    expect(Object.keys(detail)).toEqual(["get"]);
    expect(list.get["x-scope"]).toBe("full");
    expect(detail.get["x-scope"]).toBe("full");
    expect(list.get.responses["200"].content["application/json"].schema.properties).toMatchObject({
      object: { const: "list" }, has_more: { const: false },
      data: { items: { $ref: "#/components/schemas/AutomationPreset" } },
    });
    expect(detail.get.responses["200"].content["application/json"].schema.allOf).toContainEqual({
      $ref: "#/components/schemas/AutomationPresetDetail",
    });
    expect(detail.get.responses["404"]).toEqual({ $ref: "#/components/responses/NotFound" });
    expect(spec.paths["/template-library/automations/{slug}/install"].post["x-scope"]).toBe("full");
  });

  it("documents exact preset fields, nullable template stage and guidance", () => {
    const schemas = spec.components.schemas;
    expect(Object.keys(schemas.AutomationPreset.properties).sort()).toEqual(Object.keys(presets[0]!).sort());
    expect(schemas.AutomationPreset.required.sort()).toEqual(Object.keys(presets[0]!).sort());
    expect(schemas.AutomationPreset.properties.steps.items).toEqual({ $ref: "#/components/schemas/StoredAutomationStep" });
    expect(schemas.AutomationPresetDetail.allOf[1]).toMatchObject({
      properties: { object: { const: "automation_preset" } },
    });
    expect(schemas.LibraryTemplate.properties.stage).toMatchObject({ type: ["string", "null"] });
    expect(schemas.LibraryTemplate.properties.when).toEqual({ type: "string" });
    expect(schemas.LibraryTemplate.required).toEqual(expect.arrayContaining(["stage", "when"]));
  });
});

describe("automation preset install route", () => {
  it("owns the transaction and presents the existing full automation without changing resource arrays", async () => {
    const { app, library } = await harness(["full"], "full", true);
    const preset = library.automations.find((item) => item.slug === "onboarding-drip")!;
    installer.mockResolvedValueOnce({
      automation: { id: "automation_1", name: preset.name, trigger_type: "contact_created", trigger: "@contact.created",
        steps: preset.steps, connections: preset.connections, enabled: false, reentry: "once", version: 0, created_at: "now", updated_at: "now" },
      templates: { created: [], reused: [] }, events: [], properties: [], next_steps: ["Enable the automation"],
    });
    try {
      const response = await app.inject({ method: "POST", url: `/template-library/automations/${preset.slug}/install`, payload: { from: "Acme <you@acme.com>", topic_id: "topic_1" } });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ automation: { object: "automation", id: "automation_1", status: "disabled", version: 0 },
        templates: { created: [], reused: [] }, events: [], properties: [], next_steps: ["Enable the automation"] });
      expect(installer.mock.calls.at(-1)!.slice(1)).toEqual([
        "tenant_1", { object: "automation_preset", ...preset },
        preset.templates.map((slug) => library.templates.find((entry) => entry.slug === slug)),
        { from: "Acme <you@acme.com>", topic_id: "topic_1" }, library.version,
      ]);
    } finally { await app.close(); }
  });

  it.each([
    { body: {}, status: 422, name: "validation_error" },
    { body: { from: "" }, status: 422, name: "validation_error" },
    { body: { from: "not an address" }, status: 400, name: "validation_error" },
    { body: { from: "you@acme.com", name: "" }, status: 400, name: "validation_error" },
    { body: { from: "you@acme.com", topic_id: 3 }, status: 400, name: "validation_error" },
  ])("refuses invalid bodies before a transaction ($status)", async ({ body, status, name }) => {
    const { app } = await harness(["full"], "full", true);
    const before = transaction.mock.calls.length;
    try {
      const result = await app.inject({ method: "POST", url: "/template-library/automations/onboarding-drip/install", payload: body });
      expect(result.statusCode).toBe(status);
      expect(result.json().name).toBe(name);
      expect(transaction.mock.calls.length).toBe(before);
    } finally { await app.close(); }
  });

  it.each([
    { permissions: ["read"], scope: "full", status: 403 },
    { permissions: ["full"], scope: "send", status: 401 },
  ])("inherits write restrictions ($status)", async ({ permissions, scope, status }) => {
    const { app } = await harness(permissions, scope, true);
    const before = transaction.mock.calls.length;
    try {
      expect((await app.inject({ method: "POST", url: "/template-library/automations/onboarding-drip/install", payload: { from: "you@acme.com" } })).statusCode).toBe(status);
      expect(transaction.mock.calls.length).toBe(before);
    } finally { await app.close(); }
  });
});
