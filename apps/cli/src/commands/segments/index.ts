import { Command } from "@commander-js/extra-typings";
import { helpText } from "../../lib/help.js";
import { contacts } from "./contacts.js";
import { create } from "./create.js";
import { remove } from "./delete.js";
import { get } from "./get.js";
import { list } from "./list.js";
import { update } from "./update.js";

export const segments = new Command("segments")
  .description("Manage segments of contacts")
  .addHelpText("after", helpText({ examples: ["dispatch segments", "dispatch segments contacts seg_123"] }))
  .addCommand(list, { isDefault: true })
  .addCommand(create)
  .addCommand(get)
  .addCommand(update)
  .addCommand(remove)
  .addCommand(contacts);
