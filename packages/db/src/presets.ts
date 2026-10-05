import {
  ApiError, automationGraphSchema, automationSchema, baseSendSchema, id, parseAddress,
  type Connection, type EventInput, type PropertyInput, type PropertyType, type Step, type TriggerConfig,
} from "@dispatchmail/core";
import type { Queryable } from "./index.js";
import { automationColumns, type AutomationRow } from "./automations.js";
import { usedKeys } from "./automation-edits.js";
import { assertTriggerConfig } from "./contact-triggers.js";
import { assertSendKinds } from "./send-kinds.js";
import { installLibraryMissing, type LibraryInstallEntry } from "./templates.js";

export type AutomationInstallInput = {
  name?: string;
  from: string;
  topic_id?: string;
};

export type AutomationPreset = {
  slug: string;
  name: string;
  stage: "acquisition" | "onboarding" | "retention" | "reengagement" | "dunning" | "reactivation";
  description: string;
  when: string;
  trigger_config: TriggerConfig;
  reentry: "once" | "every_time";
  events: Array<EventInput & { schema: NonNullable<EventInput["schema"]> }>;
  properties: Array<Pick<PropertyInput, "key" | "type">>;
  steps: Step[];
  connections: Connection[];
  templates: string[];
};

export type AutomationInstallation = {
  automation: AutomationRow;
  templates: {
    created: Array<{ id: string; slug: string }>;
    reused: Array<{ id: string; slug: string }>;
  };
  events: Array<{ id: string; name: string }>;
  properties: Array<{ id: string; key: string; type: PropertyType }>;
  next_steps: string[];
};

type EventRow = { id: string; name: string; schema: Record<string, string>; deleted_at: string | null };
type PropertyRow = { id: string; key: string; type: PropertyType; deleted_at: string | null };

async function installEvent(client: Queryable, tenantId: string, event: AutomationPreset["events"][number]) {
  const read = async () => (await client.query<EventRow>(
    "select id, name, schema, deleted_at from event_schemas where tenant_id = $1 and name = $2 for update",
    [tenantId, event.name],
  )).rows[0];
  let row = await read();
  if (!row) {
    row = (await client.query<EventRow>(
      `insert into event_schemas (id, tenant_id, name, schema) values ($1, $2, $3, $4)
       on conflict (tenant_id, name) do nothing returning id, name, schema, deleted_at`,
      [id("evdef"), tenantId, event.name, JSON.stringify(event.schema)],
    )).rows[0];
    if (row) return { id: row.id, name: row.name };
    row = await read();
  }
  if (!row || row.deleted_at || Object.entries(event.schema).some(([key, type]) =>
    !Object.hasOwn(row.schema ?? {}, key) || row.schema[key] !== type)) {
    throw new ApiError("conflict", 409, `Event ${event.name} is incompatible or changed during installation`);
  }
  return null;
}

async function installProperty(client: Queryable, tenantId: string, property: AutomationPreset["properties"][number]) {
  const read = async () => (await client.query<PropertyRow>(
    "select id, key, type, deleted_at from contact_properties where tenant_id = $1 and key = $2 for update",
    [tenantId, property.key],
  )).rows[0];
  let row = await read();
  if (!row) {
    row = (await client.query<PropertyRow>(
      `insert into contact_properties (id, tenant_id, key, type) values ($1, $2, $3, $4)
       on conflict (tenant_id, key) do nothing returning id, key, type, deleted_at`,
      [id("prop"), tenantId, property.key, property.type],
    )).rows[0];
    if (row) return { id: row.id, key: row.key, type: row.type };
    row = await read();
  }
  if (!row || row.deleted_at || row.type !== property.type) {
    throw new ApiError("conflict", 409, `Property ${property.key} is incompatible or changed during installation`);
  }
  return null;
}

/** The caller owns the transaction, including rollback on every failure. */
export async function installAutomation(
  client: Queryable,
  tenantId: string,
  preset: AutomationPreset,
  templates: readonly LibraryInstallEntry[],
  input: AutomationInstallInput,
  version = "1.0.0",
): Promise<AutomationInstallation> {
  try {
    if (input.from === undefined || (typeof input.from === "string" && !input.from.trim())) {
      throw new ApiError("validation_error", 422, "Choose a sender");
    }
    const from = baseSendSchema.shape.from.unwrap().parse(input.from);
    if (preset.slug === "newsletter-welcome" && !input.topic_id) {
      throw new ApiError("validation_error", 422, "Choose a topic");
    }
    const domainName = parseAddress(from).email.split("@")[1]!.toLowerCase();
    const domain = (await client.query<{ id: string; sending: string | null }>(
      `select id, sending from domains
       where tenant_id = $1 and lower(name) = $2 and status = 'verified' and deleted_at is null for share`,
      [tenantId, domainName],
    )).rows[0];
    if (!domain) throw new ApiError("validation_error", 403, "Sender domain is not verified");
    if (domain.sending === "disabled") throw new ApiError("validation_error", 403, "Sending is disabled for this domain");
    if (input.topic_id !== undefined) {
      const topic = await client.query(
        "select id from topics where tenant_id = $1 and id = $2 and deleted_at is null for share",
        [tenantId, input.topic_id],
      );
      if (!topic.rows[0]) throw new ApiError("validation_error", 422, "Choose an existing topic");
    }

    const source = structuredClone(preset);
    if (source.trigger_config.type === "topic_subscribed") {
      if (!input.topic_id) throw new ApiError("validation_error", 422, "Choose a topic");
      source.trigger_config.topic_id = input.topic_id;
    }
    for (const step of source.steps) {
      if (step.type === "trigger") step.config = source.trigger_config;
    }
    const graph = automationGraphSchema.parse({ steps: source.steps, connections: source.connections });
    for (const step of graph.steps) {
      if (step.type !== "send_email") continue;
      step.config.from = from;
      if (step.config.kind === "marketing" && input.topic_id) step.config.topic_id = input.topic_id;
      else delete step.config.topic_id;
    }
    // Validate the name and graph before any resource writes.
    const normalized = automationSchema.parse({
      name: input.name ?? preset.name, status: "disabled", reentry: preset.reentry,
      steps: graph.steps, connections: graph.connections,
    });
    const slugs = [...new Set(preset.templates)];
    const entries = new Map(templates.map((entry) => [entry.slug, entry]));
    for (const slug of slugs) {
      if (!entries.has(slug)) throw new ApiError("conflict", 409, `Template ${slug} is missing from the library`);
    }
    for (const step of normalized.steps) {
      if (step.type === "send_email" && !slugs.includes((step.config.template as { id: string }).id)) {
        throw new ApiError("conflict", 409, `Step ${step.key} references an undeclared library template`);
      }
    }

    // A stable acquisition order avoids inverted dependency locks between presets.
    // Unique inserts plus a locked reread resolve winners, not an absence check alone.
    const createdEvents = new Map<string, { id: string; name: string }>();
    for (const event of [...preset.events].sort((a, b) => a.name.localeCompare(b.name))) {
      const created = await installEvent(client, tenantId, event);
      if (created) createdEvents.set(event.name, created);
    }
    const createdProperties = new Map<string, { id: string; key: string; type: PropertyType }>();
    for (const property of [...preset.properties].sort((a, b) => a.key.localeCompare(b.key))) {
      const created = await installProperty(client, tenantId, property);
      if (created) createdProperties.set(property.key, created);
    }
    const installed = new Map<string, { id: string; created: boolean }>();
    for (const slug of [...slugs].sort()) {
      installed.set(slug, await installLibraryMissing(client, tenantId, entries.get(slug)!, version));
    }
    for (const step of normalized.steps) {
      if (step.type !== "send_email") continue;
      const template = step.config.template as { id: string; variables: Record<string, unknown> };
      template.id = installed.get(template.id)!.id;
    }
    await assertTriggerConfig(client, tenantId, normalized.trigger_config);
    await assertSendKinds(client, tenantId, normalized.steps, false);
    const row = (await client.query<AutomationRow>(
      `insert into automations (id, tenant_id, name, trigger, steps, connections, enabled, trigger_type, reentry, used_keys)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       on conflict (tenant_id, name) where deleted_at is null do nothing
       returning ${automationColumns}`,
      [id("automation"), tenantId, normalized.name, normalized.trigger, JSON.stringify(normalized.steps),
        JSON.stringify(normalized.connections), false, normalized.trigger_type, normalized.reentry,
        JSON.stringify(usedKeys(normalized.steps))],
    )).rows[0];
    if (!row) throw new ApiError("conflict", 409, `An automation named ${normalized.name} already exists`);
    const resources: AutomationInstallation["templates"] = { created: [], reused: [] };
    for (const slug of slugs) {
      const template = installed.get(slug)!;
      resources[template.created ? "created" : "reused"].push({ id: template.id, slug });
    }
    const missingTopic = !input.topic_id && normalized.steps.some((step) =>
      step.type === "send_email" && step.config.kind === "marketing");
    return {
      automation: row,
      templates: resources,
      events: [...new Set(preset.events.map((event) => event.name))].flatMap((name) => createdEvents.get(name) ?? []),
      properties: [...new Set(preset.properties.map((property) => property.key))].flatMap((key) => createdProperties.get(key) ?? []),
      next_steps: [
        ...(missingTopic ? ["Choose a topic for marketing steps"] : []),
        "Review the automation and its emails", "Enable the automation",
      ],
    };
  } catch (error) {
    // The surrounding transaction must roll back, including when PostgreSQL aborted it.
    if (typeof error === "object" && error !== null && "code" in error &&
      (error.code === "23505" || error.code === "40P01" || error.code === "40001")) {
      throw new ApiError("conflict", 409, "Dependencies changed during installation; try again");
    }
    throw error;
  }
}
