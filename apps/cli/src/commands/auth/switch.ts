import { Command } from "@commander-js/extra-typings";
import pc from "picocolors";
import { guard } from "../../lib/actions.js";
import { store } from "../../lib/config.js";
import { helpText } from "../../lib/help.js";
import { output } from "../../lib/output.js";
import { pickProfile } from "./pick.js";

export const switchCommand = new Command("switch")
  .description("Make a saved profile the active one")
  .argument("[name]", "Profile name")
  .addHelpText(
    "after",
    helpText({ output: '{"active_profile":"prod"}', codes: ["missing_id", "profile_not_found"], examples: ["dispatch auth switch prod"] }),
  )
  .action(async (name, _options, command) => {
    await guard(command, "auth_error", async (globals) => {
      const credentials = store.read();
      const target = await pickProfile(name, globals, credentials);
      credentials.active_profile = target;
      store.write(credentials);
      output({ active_profile: target }, globals, () => console.log(`${pc.green("✓")} Switched to ${pc.bold(target)}`));
    });
  });
