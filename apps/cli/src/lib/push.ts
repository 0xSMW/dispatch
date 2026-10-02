import { readdir, stat } from "node:fs/promises";
import { basename, extname, join, relative } from "node:path";
import type { Result } from "@dispatchmail/sdk";
import { ApiError } from "./errors.js";
import { loadFile, type TemplateSource } from "./react.js";

type TemplateBody = { id: string; current_version_id?: string | null };

export type PushClient = {
  get(idOrAlias: string): Promise<Result<TemplateBody>>;
  create(input: Record<string, unknown>): Promise<Result<TemplateBody>>;
  update(idOrAlias: string, input: Record<string, unknown>): Promise<Result<TemplateBody>>;
  publish(idOrAlias: string): Promise<Result<unknown>>;
};

async function data<T>(pending: Promise<Result<T>>): Promise<T> {
  const result = await pending;
  if (result.error) throw new ApiError(result.error);
  return result.data as T;
}

export async function pushTemplates(client: PushClient, target: string, publish = false) {
  const root = await stat(target);
  const files = root.isDirectory() ? await emailFiles(target) : [target];
  const rows = [];
  for (const file of files) rows.push(await pushFile(client, file, root.isDirectory() ? target : undefined, publish));
  return rows;
}

// The same registered symbol the Each component in @dispatchmail/templates looks for. A list prop
// carrying it renders as one `{{{#each KEY}}}` block instead of a row per item.
const listKey = Symbol.for("dispatch.list");

function listPlaceholder(key: string, fields: string[]) {
  const item = Object.fromEntries(fields.map((field) => [field, `{{{${field}}}}`]));
  return Object.assign([item], { [listKey]: key });
}

// The brand names the API fills on every send. Without these a component that defaults its
// `brand` prop to sample values would store "Example" and example.com in the template.
const brandPlaceholders = {
  productName: "{{{PRODUCT_NAME}}}",
  productUrl: "{{{PRODUCT_URL}}}",
  logoUrl: "{{{LOGO_URL}}}",
  color: "{{{BRAND_COLOR}}}",
  textColor: "{{{BRAND_TEXT_COLOR}}}",
  supportEmail: "{{{SUPPORT_EMAIL}}}",
  supportUrl: "{{{SUPPORT_URL}}}",
  privacyUrl: "{{{PRIVACY_URL}}}",
  companyName: "{{{COMPANY_NAME}}}",
  companyAddress: "{{{COMPANY_ADDRESS}}}",
  year: "{{{CURRENT_YEAR}}}",
  unsubscribeUrl: "{{{UNSUBSCRIBE_URL}}}",
};

export function placeholderProps(variables: TemplateSource[], brand = true) {
  const props: Record<string, unknown> = {};
  for (const variable of variables) {
    if (!variable.prop) continue;
    props[variable.prop] =
      variable.type === "list" ? listPlaceholder(variable.key, variable.fields ?? []) : `{{{${variable.key}}}}`;
  }
  // A component that declares its own `brand` variable, or sets `Brand = false`, is left alone.
  if (brand && !("brand" in props)) props.brand = { ...brandPlaceholders };
  return props;
}

async function pushFile(client: PushClient, file: string, dir: string | undefined, publish: boolean) {
  const loaded = await loadFile(file);
  const html = await loaded.render(placeholderProps(loaded.variables, loaded.brand));
  const alias = templateAlias(file, dir);
  const source = { kind: "react-email", path: relative(process.cwd(), file) || file };
  const body = {
    subject: loaded.subject,
    html,
    variables: loaded.variables.map(variableBody),
    source,
    ...(loaded.track === undefined ? {} : { track: loaded.track }),
    publish: false,
  };
  const existing = await client.get(alias);
  if (existing.error && existing.error.statusCode !== 404) throw new ApiError(existing.error);
  const action: "created" | "updated" = existing.data ? "updated" : "created";
  const saved = existing.data
    ? await data(client.update(existing.data.id, body))
    : await data(client.create({ name: alias, alias, ...body }));
  if (publish) await data(client.publish(saved.id));
  return {
    alias,
    action,
    id: saved.id,
    version_id: saved.current_version_id ?? null,
    status: publish ? "published" : "draft",
  };
}

function variableBody(variable: TemplateSource) {
  return {
    key: variable.key,
    type: variable.type ?? "string",
    fallback_value: variable.fallback_value ?? null,
    ...(variable.fields ? { fields: variable.fields } : {}),
  };
}

function templateAlias(file: string, dir?: string) {
  const path = dir ? relative(dir, file) : basename(file);
  return path
    .slice(0, path.length - extname(path).length)
    .split("\\")
    .join("/");
}

async function emailFiles(dir: string): Promise<string[]> {
  const names = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const name of names) {
    if (name.name.startsWith("_") || name.name.startsWith(".")) continue;
    const path = join(dir, name.name);
    if (name.isDirectory()) files.push(...(await emailFiles(path)));
    else if (name.name.endsWith(".tsx")) files.push(path);
  }
  return files;
}
