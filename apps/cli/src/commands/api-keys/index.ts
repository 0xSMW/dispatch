import { Command } from "@commander-js/extra-typings";
import { helpText } from "../../lib/help.js";
import { create } from "./create.js";
import { remove } from "./delete.js";
import { list } from "./list.js";
import { update } from "./update.js";

export const apiKeys = new Command("api-keys")
  .description("Manage API keys")
  .addHelpText("after", helpText({ examples: ["dispatch api-keys", "dispatch api-keys create --name Production"] }))
  .addCommand(list, { isDefault: true })
  .addCommand(create)
  .addCommand(update)
  .addCommand(remove);
