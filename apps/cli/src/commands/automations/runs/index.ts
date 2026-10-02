import { Command } from "@commander-js/extra-typings";
import { helpText } from "../../../lib/help.js";
import { get } from "./get.js";
import { list } from "./list.js";

export const runs = new Command("runs")
  .description("Inspect automation runs")
  .addHelpText("after", helpText({ examples: ["dispatch automations runs auto_123", "dispatch automations runs get auto_123 run_456"] }))
  .addCommand(list, { isDefault: true })
  .addCommand(get);
