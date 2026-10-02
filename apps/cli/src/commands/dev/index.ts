import { Command } from "@commander-js/extra-typings";
import { helpText } from "../../lib/help.js";
import { seed } from "./seed.js";
import { up } from "./up.js";

export const dev = new Command("dev")
  .description("Run the local development stack (Dispatch only)")
  .addHelpText("after", helpText({ examples: ["dispatch dev up", "dispatch dev seed"] }))
  .addCommand(up)
  .addCommand(seed);
