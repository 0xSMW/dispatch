import { Command } from "@commander-js/extra-typings";
import { helpText } from "../../../lib/help.js";
import { add } from "./add.js";
import { remove } from "./remove.js";

export const batch = new Command("batch")
  .description("Add or remove many suppressions at once")
  .addHelpText("after", helpText({ examples: ["dispatch suppressions batch add --file bounced.txt"] }))
  .addCommand(add)
  .addCommand(remove);
