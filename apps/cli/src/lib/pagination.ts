import type { Command, CommandUnknownOpts, OptionValues } from "@commander-js/extra-typings";
import pc from "picocolors";
import { CliError } from "./errors.js";

export type PageFlags = { limit?: string; after?: string; before?: string };
export type Page = { limit: number; after?: string; before?: string };

export function pageOptions<A extends any[], O extends OptionValues, G extends OptionValues>(command: Command<A, O, G>) {
  return command
    .option("--limit <n>", "Number of results, from 1 to 100", "10")
    .option("--after <cursor>", "Return results after this ID")
    .option("--before <cursor>", "Return results before this ID");
}

export function page(flags: PageFlags): Page {
  const raw = flags.limit ?? "10";
  const limit = Number(raw);
  if (!/^\d+$/.test(raw) || limit < 1 || limit > 100) {
    throw new CliError("invalid_limit", "--limit must be a whole number from 1 to 100");
  }
  if (flags.after && flags.before) {
    throw new CliError("invalid_pagination", "Use --after or --before, not both");
  }
  if (flags.after) return { limit, after: flags.after };
  if (flags.before) return { limit, before: flags.before };
  return { limit };
}

export function commandPath(command: CommandUnknownOpts) {
  const names: string[] = [];
  for (let current: CommandUnknownOpts | null = command; current; current = current.parent) names.unshift(current.name());
  if (names[0] !== "dispatch") names.unshift("dispatch");
  return names.join(" ");
}

function quote(value: string) {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

// The options a command was given on the command line, as words to type again. Paging flags and
// secrets are left out.
function given(command: CommandUnknownOpts) {
  const words: string[] = [];
  for (const option of command.options) {
    const name = option.attributeName();
    if (["limit", "after", "before", "apiKey"].includes(name)) continue;
    if (command.getOptionValueSource(name) !== "cli") continue;
    const value = command.getOptionValue(name) as unknown;
    const flag = option.long ?? option.short;
    if (!flag) continue;
    if (value === true) words.push(flag);
    else if (Array.isArray(value)) for (const item of value) words.push(flag, quote(String(item)));
    else if (value !== false && value !== undefined && value !== null) words.push(flag, quote(String(value)));
  }
  return words;
}

// The hint has to return the next page of the same list: same filters, same profile, same API.
export function nextPageHint(command: CommandUnknownOpts, cursor: string, flags: PageFlags) {
  const direction = flags.before ? "--before" : "--after";
  const args = command.args.filter((arg) => !arg.startsWith("-")).slice(0, command.registeredArguments.length);
  const globals: string[] = [];
  for (let parent = command.parent; parent; parent = parent.parent) globals.unshift(...given(parent));
  const parts = [commandPath(command), ...args.map(quote), ...given(command), ...globals, "--limit", flags.limit ?? "10", direction, quote(cursor)];
  console.log(pc.dim(`\nFetch the next page: ${parts.join(" ")}`));
}
