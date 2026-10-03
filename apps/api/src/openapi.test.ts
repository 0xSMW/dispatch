import { readdirSync, readFileSync } from "node:fs";
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
