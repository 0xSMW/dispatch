import { fileURLToPath } from "node:url";
import { Command } from "@commander-js/extra-typings";
import pc from "picocolors";
import { guard } from "../../lib/actions.js";
import { ejectTemplate } from "../../lib/eject.js";
import { helpText } from "../../lib/help.js";
import { output } from "../../lib/output.js";
import { promptMissing } from "../../lib/prompts.js";

export function libraryDir() {
  return fileURLToPath(new URL("../../../../../packages/templates/emails/", import.meta.url));
}

export const eject = new Command("eject")
  .description("Copy a library template's React Email source into your project (Dispatch only)")
  .argument("[slug]", "Library slug, such as password-reset")
  .option("--dir <dir>", "Destination directory", "emails")
  .option("--force", "Replace files that already exist, including the shared _components and _theme")
  .addHelpText(
    "after",
    helpText({
      output: '{"object":"template","slug":"password-reset","dir":"emails"}',
      codes: ["missing_flags", "not_found", "exists", "eject_error"],
      examples: ["dispatch templates eject password-reset --dir emails", "dispatch templates push emails --publish"],
    }),
  )
  .action(async (slug, options, command) => {
    await guard(command, "eject_error", async (globals) => {
      const asked = await promptMissing(
        { slug },
        [{ key: "slug", flag: "<slug>", label: "Library slug", placeholder: "password-reset" }],
        globals,
      );
      await ejectTemplate(libraryDir(), asked.slug, options.dir, { force: options.force });
      output({ object: "template", slug: asked.slug, dir: options.dir }, globals, () =>
        console.log(`${pc.green("✓")} Copied ${asked.slug}.tsx and its shared files to ${options.dir}/`),
      );
    });
  });
