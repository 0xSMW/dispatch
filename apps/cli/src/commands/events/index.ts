import { Command } from "@commander-js/extra-typings";
import { helpText } from "../../lib/help.js";
import { create } from "./create.js";
import { remove } from "./delete.js";
import { get } from "./get.js";
import { history } from "./history.js";
import { list } from "./list.js";
import { send } from "./send.js";
import { update } from "./update.js";

export const events = new Command("events")
  .description("Define events and fire them to start automations")
  .addHelpText(
    "after",
    helpText({ examples: ["dispatch events send --event user.created --email ada@example.com", "dispatch events history"] }),
  )
  .addCommand(list, { isDefault: true })
  .addCommand(send)
  .addCommand(create)
  .addCommand(get)
  .addCommand(update)
  .addCommand(remove)
  .addCommand(history);
