import { Command } from "@commander-js/extra-typings";
import { helpText } from "../../lib/help.js";
import { exportCommand } from "./export.js";
import { get } from "./get.js";
import { list } from "./list.js";
import { open } from "./open.js";

export const logs = new Command("logs")
  .description("Inspect API request logs")
  .addHelpText("after", helpText({ examples: ["dispatch logs", "dispatch logs get log_123"] }))
  .addCommand(list, { isDefault: true })
  .addCommand(get)
  .addCommand(open)
  .addCommand(exportCommand);
