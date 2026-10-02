import { Command } from "@commander-js/extra-typings";
import { helpText } from "../../lib/help.js";
import { create } from "./create.js";
import { remove } from "./delete.js";
import { get } from "./get.js";
import { list } from "./list.js";
import { update } from "./update.js";

export const contactProperties = new Command("contact-properties")
  .description("Manage custom contact properties")
  .addHelpText("after", helpText({ examples: ["dispatch contact-properties", "dispatch contact-properties create --key plan"] }))
  .addCommand(list, { isDefault: true })
  .addCommand(create)
  .addCommand(get)
  .addCommand(update)
  .addCommand(remove);
