import { readFile } from "node:fs/promises";
import bundledLibrary from "../../../packages/templates/library.json" with { type: "json" };
import { ApiError, automationInstallSchema, renderTemplate, type Connection, type EventInput, type PropertyInput, type Step, type TriggerConfig } from "@dispatchmail/core";
import { installAutomation, installLibrary, tx, type Db, type LibraryInstallEntry, type Queryable } from "@dispatchmail/db";
import type { FastifyInstance } from "fastify";
import { presentAutomation } from "./automations.js";

export type LibraryStage = "acquisition" | "onboarding" | "retention" | "reengagement" | "dunning" | "reactivation";

export type LibraryPreset = {
  slug: string;
  name: string;
  stage: LibraryStage;
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

export type LibraryVariable = {
  key: string;
  type?: "string" | "number" | "list";
  fallback_value?: string | number | null;
  fields?: string[];
};

export type LibraryTemplate = {
  slug: string;
  name: string;
  category: string;
  kind: "transactional" | "marketing";
  stage: LibraryStage | null;
  when: string;
  track: boolean;
  subject: string;
  description: string;
  variables: LibraryVariable[];
  sample: Record<string, unknown>;
  html: string;
  text: string;
  preview?: string;
  preview_html?: string;
};

export type LibraryFile = {
  version: string;
  templates: LibraryTemplate[];
  automations: LibraryPreset[];
};

const cache = new Map<string, LibraryFile>();

// A static import keeps the built-in catalog inside the server bundle. Repository
// paths relative to import.meta.url are unavailable in a serverless deployment.
export async function loadLibrary(file?: URL) {
  if (!file) return bundledLibrary as unknown as LibraryFile;
  const key = file.href;
  const hit = cache.get(key);
  if (hit) return hit;
  const parsed = JSON.parse(await readFile(file, "utf8")) as LibraryFile;
  cache.set(key, parsed);
  return parsed;
}

export function listLibrary(library: LibraryFile) {
  return {
    object: "list" as const,
    has_more: false,
    data: library.templates.map((entry) => summary(entry)),
  };
}

export function libraryEntry(library: LibraryFile, slug: string) {
  const entry = library.templates.find((item) => item.slug === slug);
  if (!entry) throw new ApiError("not_found", 404, "Template not found");
  return entry;
}

export function listLibraryAutomations(library: LibraryFile) {
  return { object: "list" as const, has_more: false, data: library.automations };
}

export function libraryAutomation(library: LibraryFile, slug: string) {
  const entry = library.automations.find((item) => item.slug === slug);
  if (!entry) throw new ApiError("not_found", 404, "Automation preset not found");
  return { object: "automation_preset" as const, ...entry };
}

// Registered on the authenticated API, inheriting its full-key/read-role policy.
// Listing a built-in graph never reads or writes tenant resources.
export function registerLibraryAutomations(app: FastifyInstance, load = loadLibrary, db?: Db) {
  app.get("/template-library/automations", async () => listLibraryAutomations(await load()));
  app.get("/template-library/automations/:slug", async (request) =>
    libraryAutomation(await load(), (request.params as { slug: string }).slug));
  if (db) app.post("/template-library/automations/:slug/install", async (request) => {
    const library = await load();
    const preset = libraryAutomation(library, (request.params as { slug: string }).slug);
    const sender = (request.body as { from?: unknown } | null)?.from;
    if (sender === undefined || (typeof sender === "string" && !sender.trim())) {
      throw new ApiError("validation_error", 422, "Choose a sender");
    }
    const input = automationInstallSchema.parse(request.body);
    const entries = preset.templates.map((slug) => libraryEntry(library, slug));
    const result = await tx(db, (client) =>
      installAutomation(client, request.auth!.tenant_id, preset, entries, input, library.version));
    return { ...result, automation: presentAutomation(result.automation) };
  });
}

// What a library preview stands in for. A broadcast gives every recipient a name and an
// unsubscribe link, and marketing templates print the company address, which a new tenant has not
// entered yet. Without these the newsletter preview failed with "Missing template variable".
export function previewContext(brand: Record<string, unknown> = {}) {
  const unsubscribe = "https://example.com/unsubscribe";
  return {
    ...brand,
    COMPANY_ADDRESS: brand.COMPANY_ADDRESS || "123 Example Street, Springfield",
    contact: { first_name: "Ada", last_name: "Lovelace", email: "ada@example.com" },
    FIRST_NAME: "Ada",
    LAST_NAME: "Lovelace",
    EMAIL: "ada@example.com",
    UNSUBSCRIBE_URL: unsubscribe,
    RESEND_UNSUBSCRIBE_URL: unsubscribe,
    DISPATCH_UNSUBSCRIBE_URL: unsubscribe,
  };
}

export function previewLibrary(entry: LibraryTemplate, context: Record<string, unknown> = {}) {
  // `preview` is the template's inbox preview text. The rendered sample has its own field.
  return {
    object: "template_library" as const,
    ...summary(entry),
    rendered: renderTemplate(
      { subject: entry.subject, html: entry.html, text: entry.text, variables: entry.variables },
      entry.sample ?? {},
      previewContext(context),
    ),
  };
}

export async function installLibraryTemplate(db: Queryable, tenantId: string, library: LibraryFile, slug: string) {
  const entry = libraryEntry(library, slug);
  const write: LibraryInstallEntry = {
    slug: entry.slug,
    name: entry.name,
    subject: entry.subject,
    html: entry.html,
    text: entry.text,
    track: entry.track,
    variables: entry.variables,
    kind: entry.kind,
  };
  await installLibrary(db, tenantId, [write], library.version);
  const row = await db.query<{ id: string }>(
    "select id from templates where tenant_id = $1 and alias = $2 and deleted_at is null",
    [tenantId, slug],
  );
  return { object: "template" as const, id: row.rows[0]?.id };
}

function summary(entry: LibraryTemplate) {
  return {
    slug: entry.slug,
    name: entry.name,
    category: entry.category,
    kind: entry.kind,
    stage: entry.stage,
    when: entry.when,
    track: entry.track,
    subject: entry.subject,
    description: entry.description,
    variables: entry.variables,
    sample: entry.sample,
    preview: entry.preview,
  };
}
