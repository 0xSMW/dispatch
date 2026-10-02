import { Command } from "@commander-js/extra-typings";
import pc from "picocolors";
import { guard } from "../../lib/actions.js";
import { store } from "../../lib/config.js";
import { helpText } from "../../lib/help.js";
import { output } from "../../lib/output.js";
import { confirm } from "../../lib/prompts.js";
import { pickProfile } from "./pick.js";

export const remove = new Command("remove")
  .alias("rm")
  .description("Delete a saved profile")
  .argument("[name]", "Profile name")
  .option("--yes", "Skip the confirmation prompt")
  .addHelpText(
    "after",
    helpText({
      output: '{"removed":"prod","active_profile":"default"}',
      codes: ["missing_id", "profile_not_found", "confirmation_required"],
      examples: ["dispatch auth remove prod --yes"],
    }),
  )
  .action(async (name, options, command) => {
    await guard(command, "auth_error", async (globals) => {
      const credentials = store.read();
      const target = await pickProfile(name, globals, credentials);
      await confirm(`Remove profile ${target}?`, options.yes, globals);
      delete credentials.profiles[target];
      if (credentials.active_profile === target) credentials.active_profile = Object.keys(credentials.profiles)[0];
      store.write(credentials);
      output({ removed: target, active_profile: credentials.active_profile ?? null }, globals, () =>
        console.log(`${pc.green("✓")} Removed profile ${target}`),
      );
    });
  });
