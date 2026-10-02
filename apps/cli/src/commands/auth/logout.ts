import { Command } from "@commander-js/extra-typings";
import pc from "picocolors";
import { guard } from "../../lib/actions.js";
import { store } from "../../lib/config.js";
import { helpText } from "../../lib/help.js";
import { output } from "../../lib/output.js";

// A factory: login and logout sit both at the top level and under auth, and a
// Commander command can only have one parent.
export const logout = () =>
  new Command("logout")
    .description("Remove the saved key for a profile (the active one by default)")
    .option("--all", "Remove every profile")
    .addHelpText(
      "after",
      helpText({
        output: '{"removed":["default"],"active_profile":null}',
        examples: ["dispatch logout", "dispatch logout -p prod", "dispatch logout --all"],
      }),
    )
    .action(async (options, command) => {
      await guard(command, "logout_error", async (globals) => {
        const credentials = store.read();
        const name = globals.profile ?? process.env.DISPATCH_PROFILE ?? credentials.active_profile ?? "default";
        const removed = options.all ? Object.keys(credentials.profiles) : credentials.profiles[name] ? [name] : [];
        for (const profile of removed) delete credentials.profiles[profile];
        if (!credentials.active_profile || !credentials.profiles[credentials.active_profile]) {
          credentials.active_profile = Object.keys(credentials.profiles)[0];
        }
        if (removed.length) store.write(credentials);
        output({ removed, active_profile: credentials.active_profile ?? null }, globals, () =>
          console.log(removed.length ? `${pc.green("✓")} Logged out of ${removed.join(", ")}` : `Not logged in as ${name}`),
        );
      });
    });
