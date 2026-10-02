import type { CommandUnknownOpts } from "@commander-js/extra-typings";
import type { Result } from "@dispatchmail/sdk";
import pc from "picocolors";
import { requireClient, unwrap, type Api } from "./client.js";
import { fail, output, renderRecord } from "./output.js";
import { nextPageHint, page, type Page, type PageFlags } from "./pagination.js";
import { confirm } from "./prompts.js";
import { safe } from "./safe.js";
import { withSpinner } from "./spinner.js";
import { renderTable } from "./table.js";
import type { Globals } from "./tty.js";

export type Flags = Globals & PageFlags & Record<string, any>;
export type List<T> = { object?: string; has_more?: boolean; data: T[] };

export function globalsOf(command: CommandUnknownOpts): Flags {
  return command.optsWithGlobals() as Flags;
}

// Run a command body and turn any error into the CLI's error output and exit code.
export async function guard(command: CommandUnknownOpts, code: string, work: (globals: Flags) => Promise<void>) {
  const globals = globalsOf(command);
  try {
    await work(globals);
  } catch (error) {
    fail(error, code, globals);
  }
}

type Spec<T, P> = {
  prepare?: (globals: Flags) => Promise<P>;
  call: (api: Api, prepared: P, globals: Flags) => Promise<Result<T>>;
  human?: (data: T, globals: Flags) => void;
  loading?: string;
};

async function execute<T, P>(command: CommandUnknownOpts, code: string, spec: Spec<T, P>, done?: (data: T) => string) {
  await guard(command, code, async (globals) => {
    const prepared = (await spec.prepare?.(globals)) as P;
    const api = requireClient(globals);
    const data = await withSpinner(spec.loading ?? "Loading...", () => unwrap(spec.call(api, prepared, globals)), globals);
    output(data, globals, () => {
      if (done) console.log(`${pc.green("✓")} ${safe(done(data))}`);
      if (spec.human) spec.human(data, globals);
      else if (!done) renderRecord(data);
    });
  });
}

export async function runList<T, P = void>(
  command: CommandUnknownOpts,
  spec: {
    prepare?: (globals: Flags) => Promise<P>;
    call: (api: Api, page: Page, prepared: P) => Promise<Result<List<T>>>;
    columns: string[];
    row: (item: T) => unknown[];
    empty: string;
    cursor?: (item: T) => string;
  },
) {
  await guard(command, "list_error", async (globals) => {
    const current = page(globals);
    const prepared = (await spec.prepare?.(globals)) as P;
    const api = requireClient(globals);
    const result = await withSpinner("Loading...", () => unwrap(spec.call(api, current, prepared)), globals);
    output(result, globals, () => {
      const items = result.data ?? [];
      if (items.length === 0) return console.log(spec.empty);
      console.log(renderTable(spec.columns, items.map(spec.row)));
      if (result.has_more) {
        const edge = globals.before ? items[0]! : items.at(-1)!;
        const cursor = spec.cursor?.(edge) ?? (edge as unknown as { id: string }).id;
        nextPageHint(command, cursor, globals);
      }
    });
  });
}

export function runGet<T, P = void>(command: CommandUnknownOpts, spec: Spec<T, P>) {
  return execute(command, "fetch_error", spec);
}

export function runCreate<T, P = void>(command: CommandUnknownOpts, spec: Spec<T, P> & { done?: (data: T) => string }) {
  return execute(command, "create_error", { loading: "Creating...", ...spec }, spec.done);
}

export function runWrite<T, P = void>(command: CommandUnknownOpts, spec: Spec<T, P> & { done?: (data: T) => string; code?: string }) {
  return execute(command, spec.code ?? "update_error", { loading: "Saving...", ...spec }, spec.done);
}

export async function runDelete(
  command: CommandUnknownOpts,
  spec: {
    id: (globals: Flags) => Promise<string>;
    noun: string;
    call: (api: Api, id: string) => Promise<Result<unknown>>;
  },
) {
  await guard(command, "delete_error", async (globals) => {
    const id = await spec.id(globals);
    await confirm(`Delete ${spec.noun} ${id}?`, globals.yes, globals);
    const api = requireClient(globals);
    const data = await withSpinner("Deleting...", () => unwrap(spec.call(api, id)), globals);
    output(data ?? { id, deleted: true }, globals, () => {
      console.log(`${pc.green("✓")} Deleted ${spec.noun} ${safe(id)}`);
    });
  });
}
