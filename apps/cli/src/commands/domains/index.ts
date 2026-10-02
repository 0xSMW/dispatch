import { Command } from "@commander-js/extra-typings";
import { helpText } from "../../lib/help.js";
import { create } from "./create.js";
import { remove } from "./delete.js";
import { doctor } from "./doctor.js";
import { get } from "./get.js";
import { list } from "./list.js";
import { update } from "./update.js";
import { verify } from "./verify.js";

export const domains = new Command("domains")
  .description("Manage sending and receiving domains")
  .addHelpText("after", helpText({ examples: ["dispatch domains", "dispatch domains create example.com"] }))
  .addCommand(list, { isDefault: true })
  .addCommand(create)
  .addCommand(get)
  .addCommand(verify)
  .addCommand(update)
  .addCommand(remove)
  .addCommand(doctor);
