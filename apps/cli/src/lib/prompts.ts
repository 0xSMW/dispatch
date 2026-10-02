import * as p from "@clack/prompts";
import type { Result } from "@dispatchmail/sdk";
import { requireClient, unwrap, type Api } from "./client.js";
import { CliError } from "./errors.js";
import { cancel } from "./output.js";
import { safe } from "./safe.js";
import { withSpinner } from "./spinner.js";
import { interactive, jsonMode, type Globals } from "./tty.js";

export type Field<K> = { key: K; flag: string; label: string; placeholder?: string; secret?: boolean };

export function canPrompt(globals: Globals) {
  return interactive() && !jsonMode(globals);
}

// Fill missing required values from prompts, or fail with missing_flags when no one can answer.
export async function promptMissing<T extends Record<string, string | undefined>>(
  values: T,
  fields: Array<Field<keyof T>>,
  globals: Globals,
): Promise<T & Record<keyof T, string>> {
  const missing = fields.filter((field) => !values[field.key]);
  if (missing.length === 0) return values as T & Record<keyof T, string>;
  if (!canPrompt(globals)) {
    throw new CliError("missing_flags", `Missing required flags: ${missing.map((field) => field.flag).join(", ")}`);
  }
  const out: Record<string, string | undefined> = { ...values };
  for (const field of missing) {
    const answer = field.secret
      ? await p.password({ message: field.label })
      : await p.text({ message: field.label, placeholder: field.placeholder });
    if (p.isCancel(answer)) cancel();
    out[field.key as string] = answer;
  }
  return out as T & Record<keyof T, string>;
}

// Return the id, or let the user pick one from a list when they left it out.
export async function pick<T extends { id: string }>(
  id: string | undefined,
  spec: {
    globals: Globals;
    noun: string;
    list: (api: Api) => Promise<Result<{ data: T[] }>>;
    label: (item: T) => string;
    value?: (item: T) => string;
  },
): Promise<string> {
  if (id) return id;
  if (!canPrompt(spec.globals)) throw new CliError("missing_id", `Missing ${spec.noun} id`);
  const api = requireClient(spec.globals);
  const { data } = await withSpinner(`Loading ${spec.noun}s...`, () => unwrap(spec.list(api)), spec.globals);
  if (data.length === 0) throw new CliError("missing_id", `No ${spec.noun}s found`);
  const choice = await p.select({
    message: `Select a ${spec.noun}`,
    options: data.map((item) => ({ value: spec.value?.(item) ?? item.id, label: safe(spec.label(item)), hint: item.id })),
  });
  if (p.isCancel(choice)) cancel();
  return choice as string;
}

// Ask before a destructive action. Non-interactive runs must pass --yes.
export async function confirm(message: string, yes: boolean | undefined, globals: Globals) {
  if (yes) return;
  if (!canPrompt(globals)) {
    throw new CliError("confirmation_required", "This command is destructive. Pass --yes to confirm in non-interactive mode");
  }
  const answer = await p.confirm({ message });
  if (p.isCancel(answer) || !answer) cancel();
}
