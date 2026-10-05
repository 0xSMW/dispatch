import { readdirSync, readFileSync } from "node:fs";
import { automationGraphSchema } from "@dispatchmail/core";
import { describe, expect, it } from "vitest";
import { presentEmail, presentSend, type EmailRow } from "./present.js";

// Keeps docs/api/openapi.json in step with the routes the API registers. Reads the route modules
// as text, so it needs no database and never boots the server.

const src = new URL("./", import.meta.url);
const spec = JSON.parse(readFileSync(new URL("../../../docs/api/openapi.json", import.meta.url), "utf8")) as {
  paths: Record<string, Record<string, unknown>>;
  components: {
    schemas: {
      EventType: { enum: string[] };
      Email: { properties: Record<string, unknown> };
      EmailRecipient: { properties: Record<string, unknown> };
      SplitEmails: { items: { properties: Record<string, unknown> } };
      BatchResult: { properties: { data: { items: { properties: Record<string, unknown> } } } };
      EmailEvent: {
        properties: {
          type: { enum: string[]; description: string };
          data: { properties: Record<string, unknown> };
        };
      };
      WebhookPayload: { properties: { data: { properties: Record<string, unknown> } } };
    };
  };
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

describe("sandbox email responses", () => {
  const email: EmailRow = {
    id: "email_1",
    from_email: "hello@acme.com",
    created_at: "2026-10-03T09:00:00Z",
    subject: "Test",
    status: "queued",
  };

  it("preserves sandbox flags on send, batch item and split response shapes", () => {
    expect(presentSend({ id: "email_1", sandbox: true })).toEqual({ id: "email_1", sandbox: true });
    expect(presentSend({ id: "email_legacy" })).toEqual({ id: "email_legacy", sandbox: false });
    expect(presentSend({
      id: "email_1",
      sandbox: true,
      emails: [
        { id: "email_1", to: "test@example.com", sandbox: true },
        { id: "email_2", to: "person@acme.com", sandbox: false },
      ],
    })).toEqual({
      id: "email_1",
      sandbox: true,
      emails: [
        { id: "email_1", to: "test@example.com", sandbox: true },
        { id: "email_2", to: "person@acme.com", sandbox: false },
      ],
    });
  });

  it("exposes mixed recipient flags without changing address arrays or status", () => {
    const shown = presentEmail({
      ...email,
      sandbox: false,
      recipients: [
        { email: "test@example.com", kind: "to", sandbox: true },
        { email: "person@acme.com", kind: "cc", sandbox: false },
        { email: "test@qa.test", kind: "bcc", sandbox: true },
      ],
    });
    expect(shown).toMatchObject({
      sandbox: false,
      to: ["test@example.com"],
      cc: ["person@acme.com"],
      bcc: ["test@qa.test"],
      last_event: "queued",
      recipients: [
        { email: "test@example.com", kind: "to", sandbox: true },
        { email: "person@acme.com", kind: "cc", sandbox: false },
        { email: "test@qa.test", kind: "bcc", sandbox: true },
      ],
    });
  });

  it("exposes simulated delivery without inventing a provider ID or a new status", () => {
    expect(presentEmail({
      ...email,
      status: "delivered",
      sandbox: true,
      recipients: [{ email: "test@example.com", kind: "to", sandbox: true }],
    })).toMatchObject({ sandbox: true, message_id: null, last_event: "delivered" });
  });

  it("defaults legacy flags to false and exposes only public recipient fields", () => {
    const shown = presentEmail({
      ...email,
      recipients: [{ email: "person@acme.com", kind: "to", token: "private" } as NonNullable<EmailRow["recipients"]>[number]],
    });
    expect(shown.sandbox).toBe(false);
    expect(shown.recipients).toEqual([{ email: "person@acme.com", kind: "to", sandbox: false }]);
    expect(presentEmail(email).recipients).toEqual([]);
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

  it("documents normalized trigger shapes, nullable event names, and reentry", () => {
    const schemas = spec.components.schemas as unknown as Record<string, { properties?: Record<string, unknown>; oneOf?: Array<{ properties: { type: { const: string } } }> }>;
    expect(schemas.TriggerConfig.oneOf?.map((config) => config.properties.type.const)).toEqual([
      "event", "contact_created", "contact_updated", "topic_subscribed", "segment_added"
    ]);
    for (const name of ["Automation", "AutomationSummary"]) {
      expect(schemas[name].properties?.trigger).toMatchObject({ type: ["string", "null"] });
      expect(schemas[name].properties?.trigger_config).toEqual({ $ref: "#/components/schemas/TriggerConfig" });
      expect(schemas[name].properties?.reentry).toMatchObject({ enum: ["once", "every_time"] });
    }
  });

  it("documents pause statuses, read-only graph versions, and create/update distinctions", () => {
    const schemas = spec.components.schemas as unknown as Record<string, { required?: string[]; properties: Record<string, unknown> }>;
    for (const name of ["Automation", "AutomationSummary"]) {
      expect(schemas[name].properties.status).toMatchObject({ enum: ["enabled", "paused", "disabled"] });
      expect(schemas[name].properties.version).toMatchObject({ type: "integer", readOnly: true });
      expect(schemas[name].required).toEqual(expect.arrayContaining(["status", "version"]));
    }
    expect(schemas.AutomationInput.properties.status).toMatchObject({ enum: ["enabled", "disabled"] });
    expect(schemas.AutomationUpdate.properties.status).toMatchObject({ enum: ["enabled", "paused", "disabled"] });
    for (const name of ["AutomationInput", "AutomationUpdate"]) {
      expect(schemas[name].properties.enabled).toMatchObject({ type: "boolean" });
      expect(schemas[name].properties.version).toBeUndefined();
    }
    expect(spec.paths["/automations"].get).toMatchObject({
      parameters: expect.arrayContaining([{ name: "status", in: "query", required: false,
        description: expect.any(String), schema: { type: "string", enum: ["enabled", "paused", "disabled"] } }]),
    });
    for (const operation of [spec.paths["/automations"].post, spec.paths["/automations/{id}"].patch]) {
      expect(operation).toMatchObject({ responses: { "409": { $ref: "#/components/responses/Conflict" } } });
    }
  });

  it("accepts legacy send kinds in input but requires explicit kinds in automation responses", () => {
    const schemas = spec.components.schemas as unknown as Record<string, {
      required?: string[]; properties?: Record<string, unknown>; allOf?: unknown[]; description?: string;
    }>;
    expect(schemas.SendEmailConfig.properties?.kind).toMatchObject({ enum: ["transactional", "marketing"] });
    expect(schemas.SendEmailConfig.required).toEqual(["template"]);
    expect(schemas.SendEmailConfig.allOf).toEqual([{
      if: { properties: { kind: { const: "transactional" } }, required: ["kind"] },
      then: { not: { required: ["topic_id"] } },
    }]);
    expect(schemas.StoredSendEmailConfig).toMatchObject({
      allOf: [{ $ref: "#/components/schemas/SendEmailConfig" }], required: ["kind"],
    });
    expect(schemas.StoredAutomationStep.allOf).toEqual([
      { $ref: "#/components/schemas/AutomationStep" },
      {
        if: { properties: { type: { const: "send_email" } }, required: ["type"] },
        then: { properties: { config: { $ref: "#/components/schemas/StoredSendEmailConfig" } } },
      },
    ]);
    expect(schemas.Automation.properties?.steps).toMatchObject({
      items: { $ref: "#/components/schemas/StoredAutomationStep" },
    });
    expect(schemas.SendEmailConfig.description).toMatch(/inferred.*topic_id/i);
    expect(schemas.SendEmailConfig.description).toMatch(/runtime.*missing or deleted/i);
    for (const name of ["SendEmail", "BatchEmail"]) {
      expect(schemas[name].properties?.kind).toBeUndefined();
      expect(schemas[name].properties?.topic_id).toBeDefined();
      expect(schemas[name].required).not.toContain("topic_id");
    }
  });

  it("documents Marketing drafts, enable/resume readiness and template kind restrictions", () => {
    const schemas = spec.components.schemas as unknown as Record<string, { description: string }>;
    for (const name of ["SendEmailConfig", "AutomationInput", "AutomationUpdate"]) {
      expect(schemas[name].description).toMatch(/drafts.*omit|drafts.*without a topic/i);
      expect(schemas[name].description).toMatch(/422.*live topic/i);
      expect(schemas[name].description).toMatch(/marketing template.*transactionally/i);
    }
    for (const operation of [spec.paths["/automations"].post, spec.paths["/automations/{id}"].patch]) {
      expect(operation).toMatchObject({ responses: {
        "422": { $ref: "#/components/responses/UnprocessableEntity" },
      } });
    }
    expect(schemas.AutomationUpdate.description).toMatch(/enabling or resuming/i);
    expect(schemas.Broadcast.description).toMatch(/always Marketing/);
  });

  it("publishes read-only template kinds without confusing source provenance with send kind", () => {
    const schemas = spec.components.schemas as unknown as Record<string, { required?: string[]; properties: Record<string, unknown> }>;
    expect(schemas.Template.required).toContain("kind");
    expect(schemas.Template.properties.kind).toMatchObject({
      enum: ["transactional", "marketing"], readOnly: true,
    });
    const kind = JSON.stringify(schemas.Template.properties.kind);
    expect(kind).toContain("source.send_kind");
    expect(kind).toMatch(/unsubscribe placeholders/i);
    expect(schemas.TemplateSource.properties.send_kind).toMatchObject({ enum: ["transactional", "marketing"] });
    expect(schemas.TemplateSource.properties.kind).toMatchObject({ type: "string" });
    expect(schemas.LibraryTemplate.properties.kind).toMatchObject({ enum: ["transactional", "marketing"] });
    for (const name of ["TemplateInput", "TemplateUpdate"]) {
      expect(schemas[name].properties.kind).toBeUndefined();
    }
  });

  it("documents Exit, Filter and ordered Branch configs using the shared Rule schema", () => {
    const schemas = spec.components.schemas as unknown as Record<string, {
      properties: Record<string, unknown>;
      allOf?: Array<{ if: { properties: { type: { const: string } } }; then: unknown }>;
    }>;
    expect(schemas.AutomationStep.properties.type).toMatchObject({
      enum: expect.arrayContaining(["exit", "filter", "branch"]),
    });
    for (const [type, config] of [["exit", "ExitConfig"], ["filter", "FilterConfig"], ["branch", "BranchConfig"]]) {
      expect(schemas.AutomationStep.allOf?.find((item) => item.if.properties.type.const === type)?.then).toMatchObject({
        properties: { config: { $ref: `#/components/schemas/${config}` } },
      });
    }
    expect(schemas.ExitConfig).toMatchObject({ type: "object", properties: {}, additionalProperties: false });
    expect(schemas.FilterConfig).toMatchObject({
      type: "object", required: expect.arrayContaining(["rule", "scope"]),
      properties: { rule: { $ref: "#/components/schemas/Rule" }, scope: { enum: ["next", "following"] } },
    });
    expect(schemas.BranchConfig.properties.paths).toMatchObject({
      type: "array", minItems: 2, maxItems: 10,
      items: {
        type: "object", required: expect.arrayContaining(["key", "label", "rule"]),
        properties: {
          key: { type: "string", minLength: 1, not: { const: "otherwise" } },
          label: { type: "string" }, rule: { $ref: "#/components/schemas/Rule" },
        },
      },
    });
    const branch = JSON.stringify(schemas.BranchConfig);
    expect(branch).toMatch(/first.match/i);
    expect(branch).toMatch(/unique/i);
    expect(branch).toContain("otherwise");
  });

  it("documents keyed branch/variant connections and terminal exits", () => {
    const schemas = spec.components.schemas as unknown as Record<string, { properties: Record<string, unknown>; allOf?: unknown[] }>;
    expect(schemas.AutomationConnection.properties.type).toMatchObject({
      enum: ["default", "condition_met", "condition_not_met", "timeout", "event_received", "branch", "variant"],
    });
    expect(schemas.AutomationConnection.properties.path).toMatchObject({ type: "string", minLength: 1 });
    expect(schemas.AutomationConnection.allOf).toEqual(expect.arrayContaining([expect.objectContaining({
      if: { properties: { type: { enum: ["branch", "variant"] } }, required: ["type"] },
      then: { required: ["path"] },
    })]));
    const graph = JSON.stringify(schemas.AutomationInput);
    expect(graph).toMatch(/exactly one/i);
    expect(graph).toContain("otherwise");
    expect(graph).toMatch(/only.*branch|branch.*only/i);
    expect(graph).toMatch(/exit.*no outgoing|no outgoing.*exit/i);
  });

  it("documents nullable run exit reasons and saved following-filter guards without changing statuses", () => {
    const schemas = spec.components.schemas as unknown as Record<string, { properties: Record<string, unknown>; required?: string[] }>;
    expect(schemas.AutomationRun.required).toEqual(expect.arrayContaining(["exit_reason", "guards"]));
    expect(schemas.AutomationRun.properties.status).toMatchObject({ enum: ["running", "completed", "failed", "cancelled"] });
    expect(schemas.AutomationRun.properties.exit_reason).toMatchObject({
      type: ["string", "null"], enum: ["completed", "exit", "filter", "stopped", "stranded", null],
    });
    expect(schemas.AutomationRun.properties.guards).toMatchObject({
      type: "array", items: {
        type: "object", required: expect.arrayContaining(["filter", "rule"]),
        properties: { filter: { type: "string" }, rule: { $ref: "#/components/schemas/Rule" } },
      },
    });
    const description = JSON.stringify(schemas.FilterConfig);
    expect(description).toMatch(/fresh/i);
    expect(description).toMatch(/wait/i);
    expect(description).toMatch(/never.*default|no.*default/i);
  });

  it("documents lifecycle webhook exit_reason including null for started and failed transitions", () => {
    const data = spec.components.schemas.WebhookPayload.properties.data;
    expect(data.properties.exit_reason).toMatchObject({
      type: ["string", "null"], enum: ["completed", "exit", "filter", "stopped", "stranded", null],
    });
    for (const name of ["automation_id", "run_id", "contact_id", "state"]) {
      expect(data.properties[name]).toBeDefined();
    }
    const description = JSON.stringify(data);
    expect(description).toMatch(/started.*null/i);
    expect(description).toMatch(/failed.*null/i);
  });

  it("publishes a valid graph example with all flow controls and an Otherwise edge", () => {
    const schemas = spec.components.schemas as unknown as Record<string, {
      examples?: Array<{ steps: Array<{ type: string }>; connections: Array<{ type?: string; path?: string }> }>;
    }>;
    const examples = schemas.AutomationInput.examples ?? [];
    const flow = examples.find((example) => ["exit", "filter", "branch"].every((type) => example.steps.some((step) => step.type === type)));
    expect(flow).toBeDefined();
    expect(flow?.connections).toEqual(expect.arrayContaining([{ from: expect.any(String), to: expect.any(String), type: "branch", path: "otherwise" }]));
    for (const example of examples) {
      const parsed = automationGraphSchema.safeParse(example);
      expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    }
  });

  it("documents resolved import opt-ins and the optional cancelled-contact reset", () => {
    const schemas = spec.components.schemas as unknown as Record<string, { properties: Record<string, unknown> }>;
    expect(schemas.ContactImportInput.properties.trigger_automations).toMatchObject({ enum: ["true", "false"] });
    expect(schemas.ContactImport.properties.trigger_automations).toMatchObject({ type: "boolean" });
    expect(spec.paths["/contacts/imports"].post).toMatchObject({
      responses: { "200": { content: { "application/json": { schema: {
        required: expect.arrayContaining(["trigger_automations"]),
        properties: { trigger_automations: { type: "boolean" } }
      } } } } }
    });
    expect(spec.paths["/automations/{id}/stop"].post).toMatchObject({
      requestBody: { required: false, content: { "application/json": { schema: {
        additionalProperties: false, properties: { reset_reentry: { type: "boolean", default: false } }
      } } } }
    });
  });

  it("documents non-mutating automation previews using the ordinary update body", () => {
    const operation = spec.paths["/automations/{id}"].patch;
    expect(operation).toMatchObject({
      parameters: expect.arrayContaining([{
        name: "dry_run", in: "query", required: false, description: expect.any(String),
        schema: { type: "boolean" },
      }]),
      requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/AutomationUpdate" } } } },
      responses: {
        "200": { content: { "application/json": { schema: { oneOf: [
          { allOf: [{ $ref: "#/components/schemas/Automation" }, { $ref: "#/components/schemas/RequestId" }] },
          { allOf: [{ $ref: "#/components/schemas/DryRun" }, { $ref: "#/components/schemas/RequestId" }] },
        ] } } } },
        "409": { $ref: "#/components/responses/Conflict" },
      },
    });
    const schemas = spec.components.schemas as unknown as Record<string, { properties: Record<string, unknown> }>;
    expect(schemas.DryRun).toMatchObject({
      type: "object", required: ["stranded_runs", "by_step"],
      properties: {
        stranded_runs: { type: "integer", minimum: 0 },
        by_step: { type: "object", additionalProperties: { type: "integer", minimum: 0 } },
      },
    });
    for (const name of ["Automation", "AutomationSummary", "AutomationInput", "AutomationUpdate", "DryRun"]) {
      expect(schemas[name].properties.used_keys).toBeUndefined();
    }
  });

  it("documents exact enrollment audiences, asynchronous progress and both cancellation responses", () => {
    const schemas = spec.components.schemas as unknown as Record<string, { properties: Record<string, unknown> }>;
    expect(schemas.AutomationEnrollInput).toMatchObject({ oneOf: [
      { additionalProperties: false, required: ["all"], properties: { all: { const: true } } },
      { additionalProperties: false, required: ["segment_id"] },
    ] });
    expect(schemas.AutomationEnrollmentJob.properties.status).toMatchObject({ enum: ["queued", "in_progress", "completed", "failed", "cancelled"] });
    expect(schemas.AutomationEnrollmentJob.properties.counts).toMatchObject({ required: ["total", "processed", "enrolled", "skipped", "failed"] });
    expect(spec.paths["/automations/{id}/enroll"].post).toMatchObject({
      responses: { "202": { content: { "application/json": { schema: { allOf: [
        { $ref: "#/components/schemas/AutomationEnrollmentJob" }, { $ref: "#/components/schemas/RequestId" },
      ] } } } } },
    });
    expect(spec.paths["/automations/{id}/enroll-jobs/{job_id}"].delete).toBeDefined();
    expect(spec.paths["/contacts/imports/{id}"].delete).toBeDefined();
    expect(schemas.ContactImport.properties.status).toMatchObject({ enum: expect.arrayContaining(["cancelled"]) });
  });

  it("documents sandbox flags on send, batch, split, email and recipient responses", () => {
    const operation = spec.paths["/emails"].post as {
      responses: { "200": { content: { "application/json": { schema: { properties: Record<string, unknown> } } } } };
    };
    const schemas = spec.components.schemas;
    for (const properties of [
      operation.responses["200"].content["application/json"].schema.properties,
      schemas.BatchResult.properties.data.items.properties,
      schemas.SplitEmails.items.properties,
      schemas.Email.properties,
      schemas.EmailRecipient.properties,
    ]) {
      expect(properties.sandbox).toMatchObject({ type: "boolean" });
    }
    for (const kind of ["to", "cc", "bcc"]) {
      expect(schemas.Email.properties[kind]).toEqual({ type: "array", items: { type: "string" } });
    }
    expect(schemas.Email.properties.recipients).toMatchObject({
      items: { $ref: "#/components/schemas/EmailRecipient" },
    });
  });

  it("distinguishes simulated delivery from real provider delivery in event schemas", () => {
    for (const schema of [spec.components.schemas.EmailEvent, spec.components.schemas.WebhookPayload]) {
      expect(schema.properties.data.properties.sandbox).toMatchObject({
        type: "boolean",
        description: expect.stringContaining("simulated"),
      });
    }
    expect(spec.components.schemas.WebhookPayload.properties.data.properties.sandbox).toMatchObject({
      description: expect.stringContaining("real recipients still receive provider delivery events"),
    });
  });

  it("documents lifecycle event types and repeat-safe unsubscribe webhook fanout", () => {
    const types = ["email.unsubscribed", "automation.run.started", "automation.run.completed", "automation.run.failed"];
    const event = spec.components.schemas.EmailEvent.properties.type;
    expect(spec.components.schemas.EventType.enum).toEqual(expect.arrayContaining(types));
    expect(event.enum).toEqual(expect.arrayContaining(types));
    expect(event.description).toContain("Marketing and broadcast unsubscribe links");
    expect(event.description).toContain("one `email.unsubscribed` event per email, even when used again");
    expect(event.description).toContain("enabled webhook endpoints subscribed to `email.unsubscribed`");
    expect(event.description).not.toMatch(/no webhook|broadcast recipient/i);
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
