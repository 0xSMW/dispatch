import { Command } from "@commander-js/extra-typings";
import type { Result } from "@dispatchmail/sdk";
import { runDelete, runGet, runList, type List } from "./actions.js";
import type { Api } from "./client.js";
import { helpText } from "./help.js";
import { pageOptions, type Page } from "./pagination.js";
import type { Globals } from "./tty.js";

// `<group> list`, for paginated resources with no extra arguments or filters.
export function listCommand<T>(spec: {
  description: string;
  output: string;
  examples: string[];
  call: (api: Api, page: Page) => Promise<Result<List<T>>>;
  columns: string[];
  row: (item: T) => unknown[];
  empty: string;
}) {
  const { description, output, examples, ...list } = spec;
  return pageOptions(new Command("list"))
    .alias("ls")
    .description(description)
    .addHelpText("after", helpText({ output, codes: ["invalid_limit", "invalid_pagination", "list_error"], examples }))
    .action(async (_options, command) => {
      await runList<T>(command, list);
    });
}

type Spec = {
  noun: string;
  arg?: string;
  pick: (id: string | undefined, globals: Globals) => Promise<string>;
  call: (api: Api, id: string) => Promise<Result<any>>;
  example: string;
  output?: string;
};

// `<group> get [id]`, for resources whose detail view needs nothing special.
export function getCommand(spec: Spec) {
  return new Command("get")
    .description(`Show a ${spec.noun}`)
    .argument("[id]", spec.arg ?? `${spec.noun[0]!.toUpperCase()}${spec.noun.slice(1)} ID`)
    .addHelpText("after", helpText({ output: spec.output, codes: ["missing_id", "fetch_error", "not_found"], examples: [spec.example] }))
    .action(async (id, _options, command) => {
      await runGet(command, { prepare: (globals) => spec.pick(id, globals), call: spec.call });
    });
}

// `<group> delete [id] --yes`, alias rm.
export function deleteCommand(spec: Spec) {
  return new Command("delete")
    .alias("rm")
    .description(`Delete a ${spec.noun}`)
    .argument("[id]", spec.arg ?? `${spec.noun[0]!.toUpperCase()}${spec.noun.slice(1)} ID`)
    .option("--yes", "Skip the confirmation prompt")
    .addHelpText(
      "after",
      helpText({
        output: spec.output ?? '{"id":"...","deleted":true}',
        codes: ["missing_id", "confirmation_required", "delete_error"],
        examples: [spec.example],
      }),
    )
    .action(async (id, _options, command) => {
      await runDelete(command, { noun: spec.noun, id: (globals) => spec.pick(id, globals), call: spec.call });
    });
}

// A contact can be named by ID or by email address.
export function contactRef(value: string) {
  return value.includes("@") ? { email: value } : { id: value };
}
