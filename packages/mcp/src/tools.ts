import type { Dispatch } from "@dispatchmail/sdk";

// Narrow to shipped resource methods, never expose Dispatch.call or arbitrary paths.
export type ToolClient = {
  emails: Pick<Dispatch["emails"], "send" | "get" | "list" | "metrics">;
  events: Pick<Dispatch["events"], "send">;
  contacts: Pick<Dispatch["contacts"], "create">;
  automations: Pick<Dispatch["automations"], "list">;
  templates: Pick<Dispatch["templates"], "list" | "render"> & {
    library: Pick<Dispatch["templates"]["library"], "installAutomation">;
  };
};

type Schema = {
  type?: "object" | "array" | "string" | "number" | "integer" | "boolean";
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: boolean | Schema;
  items?: Schema;
  enum?: readonly unknown[];
  anyOf?: Schema[];
  oneOf?: Schema[];
  not?: Schema;
  minItems?: number;
  minLength?: number;
  minimum?: number;
  maximum?: number;
};
const string: Schema = { type: "string" };
const nonempty: Schema = { type: "string", minLength: 1 };
const boolean: Schema = { type: "boolean" };
const record: Schema = { type: "object" };
const strings: Schema = { type: "array", items: string };
const address: Schema = { anyOf: [nonempty, { type: "array", items: nonempty, minItems: 1 }] };
const object = (properties: Record<string, Schema>, required: string[] = []): Schema & { type: "object" } =>
  ({ type: "object", properties, required, additionalProperties: false });
const page = { limit: { type: "integer", minimum: 1, maximum: 100 } as Schema, after: nonempty, before: nonempty };
const paginated = (properties: Record<string, Schema>) => ({
  ...object({ ...page, ...properties }),
  not: { type: "object" as const, required: ["after", "before"] }
});
const definitions = [
  {
    name: "send_email", description: "Send an email. Optional idempotencyKey is passed as an SDK request option.", readOnly: false,
    inputSchema: object({
      from: nonempty, to: address, cc: address, bcc: address, replyTo: address,
      subject: string, html: string, text: string,
      attachments: { type: "array", items: object({
        filename: nonempty, content: string, path: string, contentType: string, contentId: string,
        disposition: { enum: ["attachment", "inline"] }
      }, ["filename"]) },
      template: { anyOf: [nonempty, object({ id: nonempty, variables: record }, ["id"])] },
      variables: record, headers: { type: "object", additionalProperties: string },
      tags: { anyOf: [
        { type: "array", items: object({ name: string, value: string }, ["name", "value"]) },
        { type: "object", additionalProperties: string }
      ] },
      topicId: nonempty, scheduledAt: string, idempotencyKey: nonempty
    }, ["from", "to"])
  },
  { name: "get_email", description: "Get an email by ID.", readOnly: true, inputSchema: object({ id: nonempty }, ["id"]) },
  {
    name: "list_emails", description: "List emails with optional pagination and filters.", readOnly: true,
    inputSchema: paginated({ status: string, from: string, to: string, q: string, api_key_id: string })
  },
  {
    name: "send_event", description: "Send an event for exactly one contactId or email.", readOnly: false,
    inputSchema: {
      ...object({ contactId: nonempty, email: nonempty, event: nonempty, payload: record }, ["event"]),
      oneOf: [
        { type: "object" as const, required: ["contactId"] },
        { type: "object" as const, required: ["email"] }
      ]
    }
  },
  {
    name: "upsert_contact", description: "Create or update a contact by email using contacts.create.", readOnly: false,
    inputSchema: object({
      email: nonempty, firstName: string, lastName: string, properties: record, unsubscribed: boolean,
      segments: { type: "array", items: object({ id: nonempty }, ["id"]) },
      topics: { type: "array", items: object({ id: nonempty, subscription: { enum: ["opt_in", "opt_out"] } }, ["id"]) }
    }, ["email"])
  },
  {
    name: "list_automations", description: "List automations.", readOnly: true,
    inputSchema: paginated({ status: { enum: ["enabled", "paused", "disabled"] } })
  },
  {
    name: "install_preset", description: "Install an automation preset with its templates and dependencies.", readOnly: false,
    inputSchema: object({ slug: nonempty, name: string, from: nonempty, topicId: nonempty }, ["slug", "from"])
  },
  {
    name: "get_metrics", description: "Get email metrics with optional dates, dimensions and resource filters.", readOnly: true,
    inputSchema: object({
      startDate: string, endDate: string, timezone: string,
      granularity: { enum: ["hourly", "daily", "weekly", "monthly"] },
      metrics: strings, dimensions: strings, domainId: strings, emailId: strings, broadcastId: strings, automationId: strings
    })
  },
  {
    name: "list_templates", description: "List templates.", readOnly: true,
    inputSchema: paginated({ q: string, status: { enum: ["draft", "published"] } })
  },
  {
    name: "render_template", description: "Render a template by ID or alias without sending or changing it. draft previews the latest version.", readOnly: true,
    inputSchema: object({ idOrAlias: nonempty, variables: record, draft: boolean }, ["idOrAlias"])
  }
];

export function tools(readOnly = false) {
  return definitions.filter((tool) => !readOnly || tool.readOnly).map((tool) => ({
    name: tool.name, description: tool.description, inputSchema: structuredClone(tool.inputSchema),
    annotations: { readOnlyHint: tool.readOnly }
  }));
}

export type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };
function failure(name: string, message: string, statusCode: number | null = null): ToolResult {
  return { isError: true, content: [{ type: "text", text: JSON.stringify({ name, statusCode, message }) }] };
}

// Validate direct tool calls too: discovery metadata is not an authorization gate.
function valid(value: unknown, schema: Schema): boolean {
  if (schema.anyOf && !schema.anyOf.some((candidate) => valid(value, candidate))) return false;
  if (schema.oneOf && schema.oneOf.filter((candidate) => valid(value, candidate)).length !== 1) return false;
  if (schema.not && valid(value, schema.not)) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.type === "string") return typeof value === "string" && value.length >= (schema.minLength ?? 0);
  if (schema.type === "boolean") return typeof value === "boolean";
  if (schema.type === "integer" || schema.type === "number") {
    return typeof value === "number" && Number.isFinite(value) &&
      (schema.type !== "integer" || Number.isInteger(value)) &&
      value >= (schema.minimum ?? -Infinity) && value <= (schema.maximum ?? Infinity);
  }
  if (schema.type === "array") return Array.isArray(value) && value.length >= (schema.minItems ?? 0) &&
    value.every((item) => valid(item, schema.items ?? {}));
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const data = value as Record<string, unknown>;
    if (schema.required?.some((key) => !Object.hasOwn(data, key))) return false;
    return Object.entries(data).every(([key, item]) => {
      const field = Object.hasOwn(schema.properties ?? {}, key) ? schema.properties![key] : undefined;
      return field ? valid(item, field) : schema.additionalProperties === false ? false :
        typeof schema.additionalProperties === "object" ? valid(item, schema.additionalProperties) : true;
    });
  }
  return true;
}

export async function callTool(client: ToolClient, name: string, input: unknown, readOnly = false): Promise<ToolResult> {
  const tool = definitions.find((entry) => entry.name === name);
  if (!tool) return failure("unknown_tool", "Unknown tool");
  if (readOnly && !tool.readOnly) return failure("read_only", "Tool is unavailable in read-only mode");
  if (!valid(input, tool.inputSchema)) return failure("invalid_arguments", "Arguments do not match the tool schema");
  const args = input as Record<string, unknown>;
  try {
    let result;
    switch (name) {
      case "send_email": {
        const { idempotencyKey, ...payload } = args;
        result = await client.emails.send(payload as Parameters<ToolClient["emails"]["send"]>[0],
          idempotencyKey === undefined ? {} : { idempotencyKey: idempotencyKey as string });
        break;
      }
      case "get_email": result = await client.emails.get(args.id as string); break;
      case "list_emails": result = await client.emails.list(args as Parameters<ToolClient["emails"]["list"]>[0]); break;
      case "send_event": result = await client.events.send(args as Parameters<ToolClient["events"]["send"]>[0]); break;
      case "upsert_contact": result = await client.contacts.create(args as Parameters<ToolClient["contacts"]["create"]>[0]); break;
      case "list_automations": result = await client.automations.list(args as Parameters<ToolClient["automations"]["list"]>[0]); break;
      case "install_preset": {
        const { slug, ...payload } = args;
        result = await client.templates.library.installAutomation(slug as string,
          payload as Parameters<ToolClient["templates"]["library"]["installAutomation"]>[1]);
        break;
      }
      case "get_metrics": result = await client.emails.metrics(args as Parameters<ToolClient["emails"]["metrics"]>[0]); break;
      case "list_templates": result = await client.templates.list(args as Parameters<ToolClient["templates"]["list"]>[0]); break;
      case "render_template": result = await client.templates.render(args.idOrAlias as string,
        (args.variables ?? {}) as Record<string, unknown>, args.draft === undefined ? {} : { draft: args.draft as boolean }); break;
      default: return failure("unknown_tool", "Unknown tool");
    }
    // SDK transport headers and arbitrary error extras are never MCP content.
    if (result.error) return failure(result.error.name, result.error.message, result.error.statusCode);
    return { content: [{ type: "text", text: JSON.stringify(result.data) }] };
  } catch {
    // Exceptions can contain URLs, headers or credentials. Do not serialize them.
    return failure("dispatch_error", "Dispatch request failed");
  }
}
