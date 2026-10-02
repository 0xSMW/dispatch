import { Command } from "@commander-js/extra-typings";
import pc from "picocolors";
import { guard } from "../../lib/actions.js";
import { store } from "../../lib/config.js";
import { helpText } from "../../lib/help.js";
import { output } from "../../lib/output.js";
import { renderTable } from "../../lib/table.js";

export const list = new Command("list")
  .alias("ls")
  .description("List saved profiles")
  .addHelpText(
    "after",
    helpText({
      output: '{"active_profile":"default","profiles":[{"name":"default","api_url":"...","scope":"full","active":true}]}',
      examples: ["dispatch auth list"],
    }),
  )
  .action(async (_options, command) => {
    await guard(command, "auth_error", async (globals) => {
      const credentials = store.read();
      const profiles = Object.entries(credentials.profiles).map(([name, profile]) => ({
        name,
        api_url: profile.api_url,
        scope: profile.scope ?? null,
        active: name === credentials.active_profile,
      }));
      output({ active_profile: credentials.active_profile ?? null, profiles }, globals, () => {
        if (!profiles.length) return console.log("(no profiles) Run: dispatch login");
        console.log(
          renderTable(
            ["", "Profile", "API URL", "Scope"],
            profiles.map((profile) => [profile.active ? pc.green("*") : "", profile.name, profile.api_url, profile.scope ?? ""]),
          ),
        );
      });
    });
  });
