import { Command } from "@commander-js/extra-typings";
import { guard } from "../../lib/actions.js";
import { requireClient } from "../../lib/client.js";
import { helpText } from "../../lib/help.js";
import { output } from "../../lib/output.js";
import { pushTemplates } from "../../lib/push.js";
import { promptMissing } from "../../lib/prompts.js";
import { withSpinner } from "../../lib/spinner.js";
import { renderTable } from "../../lib/table.js";

export const push = new Command("push")
  .description("Store React Email files as templates, by alias (Dispatch only)")
  .argument("[path]", "A .tsx file, or a directory of them")
  .option("--publish", "Publish each template after the write")
  .addHelpText(
    "after",
    helpText({
      output: '[{"alias":"reset-password","action":"created","id":"...","version_id":"...","status":"draft"}]',
      codes: ["missing_flags", "react_email_build_error", "react_email_render_error", "push_error"],
      examples: ["dispatch templates push emails", "dispatch templates push emails/reset-password.tsx --publish"],
    }),
  )
  .action(async (path, options, command) => {
    await guard(command, "push_error", async (globals) => {
      const asked = await promptMissing(
        { path },
        [{ key: "path", flag: "<path>", label: "File or directory", placeholder: "emails" }],
        globals,
      );
      const api = requireClient(globals);
      const rows = await withSpinner("Pushing...", () => pushTemplates(api.templates, asked.path, Boolean(options.publish)), globals);
      output(rows, globals, () =>
        console.log(
          renderTable(
            ["Alias", "Action", "Version", "Status"],
            rows.map((row) => [row.alias, row.action, row.version_id ?? "", row.status]),
          ),
        ),
      );
    });
  });
