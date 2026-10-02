import { Command } from "@commander-js/extra-typings";
import { helpText } from "../../lib/help.js";
import { add } from "./add.js";
import { batch } from "./batch/index.js";
import { remove } from "./delete.js";
import { get } from "./get.js";
import { list } from "./list.js";

export const suppressions = new Command("suppressions")
  .description("Manage addresses Dispatch will not send to")
  .addHelpText("after", helpText({ examples: ["dispatch suppressions", "dispatch suppressions add gone@example.com"] }))
  .addCommand(list, { isDefault: true })
  .addCommand(add)
  .addCommand(get)
  .addCommand(remove)
  .addCommand(batch);
