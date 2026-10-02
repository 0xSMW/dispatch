import { Command } from "@commander-js/extra-typings";
import { helpText } from "../../lib/help.js";
import { list } from "./list.js";
import { login } from "./login.js";
import { logout } from "./logout.js";
import { remove } from "./remove.js";
import { rename } from "./rename.js";
import { switchCommand } from "./switch.js";

export const auth = new Command("auth")
  .description("Manage saved profiles (API URL plus key)")
  .addHelpText("after", helpText({ examples: ["dispatch auth list", "dispatch auth switch prod"] }))
  .addCommand(list, { isDefault: true })
  .addCommand(login())
  .addCommand(logout())
  .addCommand(switchCommand)
  .addCommand(rename)
  .addCommand(remove);
