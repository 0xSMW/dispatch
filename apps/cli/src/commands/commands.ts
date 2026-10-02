import { Command } from "@commander-js/extra-typings";
import { helpText } from "../lib/help.js";
import { root, tree } from "../lib/tree.js";

export const commands = new Command("commands")
  .description("Print the whole command tree as JSON, for scripts and agents")
  .addHelpText(
    "after",
    helpText({
      output: '{"name":"dispatch","aliases":[],"description":"...","options":[...],"subcommands":[...]}',
      examples: ["dispatch commands | jq '.subcommands[].name'"],
    }),
  )
  .action((_options, command) => {
    console.log(JSON.stringify(tree(root(command)), null, 2));
  });
