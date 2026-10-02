import { Command } from "@commander-js/extra-typings";
import { helpText } from "../../../lib/help.js";
import { create } from "./create.js";
import { get } from "./get.js";
import { list } from "./list.js";

export const imports = new Command("imports")
  .description("Import contacts from CSV")
  .addHelpText("after", helpText({ examples: ["dispatch contacts imports", "dispatch contacts imports create --file contacts.csv"] }))
  .addCommand(list, { isDefault: true })
  .addCommand(create)
  .addCommand(get);
