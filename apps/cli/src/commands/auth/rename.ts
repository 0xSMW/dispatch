import { Command } from "@commander-js/extra-typings";
import pc from "picocolors";
import { guard } from "../../lib/actions.js";
import { store } from "../../lib/config.js";
import { CliError } from "../../lib/errors.js";
import { helpText } from "../../lib/help.js";
import { output } from "../../lib/output.js";
import { promptMissing } from "../../lib/prompts.js";
import { pickProfile } from "./pick.js";

export const rename = new Command("rename")
  .description("Rename a saved profile")
  .argument("[from]", "Current name")
  .argument("[to]", "New name")
  .addHelpText(
    "after",
    helpText({
      output: '{"from":"default","to":"local"}',
      codes: ["missing_id", "missing_flags", "profile_not_found", "profile_exists"],
      examples: ["dispatch auth rename default local"],
    }),
  )
  .action(async (from, to, _options, command) => {
    await guard(command, "auth_error", async (globals) => {
      const credentials = store.read();
      const source = await pickProfile(from, globals, credentials);
      const { target } = await promptMissing({ target: to }, [{ key: "target", flag: "<to>", label: "New name" }], globals);
      if (credentials.profiles[target]) throw new CliError("profile_exists", `Profile "${target}" already exists`);
      credentials.profiles[target] = credentials.profiles[source]!;
      delete credentials.profiles[source];
      if (credentials.active_profile === source) credentials.active_profile = target;
      store.write(credentials);
      output({ from: source, to: target }, globals, () => console.log(`${pc.green("✓")} Renamed ${source} to ${pc.bold(target)}`));
    });
  });
