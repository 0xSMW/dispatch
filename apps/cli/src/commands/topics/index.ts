import { Command } from "@commander-js/extra-typings";
import { helpText } from "../../lib/help.js";
import { create } from "./create.js";
import { remove } from "./delete.js";
import { get } from "./get.js";
import { list } from "./list.js";
import { update } from "./update.js";

export const topics = new Command("topics")
  .description("Manage subscription topics")
  .addHelpText("after", helpText({ examples: ["dispatch topics", 'dispatch topics create --name "Product updates"'] }))
  .addCommand(list, { isDefault: true })
  .addCommand(create)
  .addCommand(get)
  .addCommand(update)
  .addCommand(remove);
