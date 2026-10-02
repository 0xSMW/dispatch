import type { CommandUnknownOpts } from "@commander-js/extra-typings";

export type Node = {
  name: string;
  aliases: string[];
  description: string;
  usage: string;
  arguments: Array<{ name: string; required: boolean; description: string }>;
  options: Array<{ flags: string; description: string; default?: unknown; choices?: readonly string[] }>;
  subcommands: Node[];
};

// Commander keeps the hidden flag private; the help system reads it the same way.
function hidden(command: CommandUnknownOpts) {
  return Boolean((command as unknown as { _hidden?: boolean })._hidden);
}

export function root(command: CommandUnknownOpts) {
  let current = command;
  while (current.parent) current = current.parent;
  return current;
}

export function visible(command: CommandUnknownOpts) {
  return command.commands.filter((child) => !hidden(child));
}

// The command tree as data, without hidden commands or hidden options.
export function tree(command: CommandUnknownOpts): Node {
  return {
    name: command.name(),
    aliases: command.aliases(),
    description: command.description(),
    usage: command.usage(),
    arguments: command.registeredArguments.map((argument) => ({
      name: argument.name(),
      required: argument.required,
      description: argument.description,
    })),
    options: command.options
      .filter((option) => !option.hidden)
      .map((option) => ({
        flags: option.flags,
        description: option.description,
        ...(option.defaultValue !== undefined ? { default: option.defaultValue } : {}),
        ...(option.argChoices ? { choices: option.argChoices } : {}),
      })),
    subcommands: visible(command).map(tree),
  };
}

// Completion candidates for every command path, keyed by the words typed so far.
// Aliases get their own paths so `dispatch domains ls --<tab>` works too.
export function paths(node: Node, globals: string[], prefix = "", out = new Map<string, string[]>()) {
  const own = node.options.map((option) => option.flags.split(/[ ,|]+/).find((part) => part.startsWith("--"))!).filter(Boolean);
  const children = node.subcommands.flatMap((child) => [child.name, ...child.aliases]);
  out.set(prefix, [...children, ...own, ...globals, "--help"]);
  for (const child of node.subcommands) {
    for (const name of [child.name, ...child.aliases]) paths(child, globals, prefix ? `${prefix} ${name}` : name, out);
  }
  return out;
}
