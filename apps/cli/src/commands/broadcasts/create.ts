import { guard } from "../../lib/actions.js";
import { requireClient, unwrap } from "../../lib/client.js";
import { CliError } from "../../lib/errors.js";
import { helpText } from "../../lib/help.js";
import { compact } from "../../lib/json.js";
import { output } from "../../lib/output.js";
import { promptMissing } from "../../lib/prompts.js";
import { withSpinner } from "../../lib/spinner.js";
import pc from "picocolors";
import { broadcastBody, broadcastCommand } from "./body.js";

export const create = broadcastCommand("create")
  .description("Create a broadcast as a draft, or send it with --send")
  .argument("[name]", "Internal name")
  .option("--send", "Send right after creating")
  .option("--scheduled-at <time>", "With --send, send at this time")
  .option("--dry-run", "Print what would be sent, in the SDK's field names, without creating")
  .addHelpText(
    "after",
    helpText({
      output: '{"id":"..."}',
      codes: ["missing_flags", "invalid_flags", "react_email_build_error", "create_error", "validation_error"],
      examples: [
        'dispatch broadcasts create --name "October news" --from news@acme.com --subject "What shipped" --segment-id seg_123 --html-file news.html',
        "dispatch broadcasts create --from news@acme.com --subject Hi --segment-id seg_123 --react-email emails/news.tsx --send",
      ],
    }),
  )
  .action(async (name, options, command) => {
    await guard(command, "create_error", async (globals) => {
      const body = await broadcastBody({ ...options, name: name ?? options.name });
      const asked = await promptMissing(
        { from: body.from, subject: body.subject },
        [
          { key: "from", flag: "--from", label: "From", placeholder: "news@example.com" },
          ...(body.template ? [] : [{ key: "subject" as const, flag: "--subject", label: "Subject" }]),
        ],
        globals,
      );
      if (!body.template && !body.html && !body.text) {
        throw new CliError(
          "missing_flags",
          "Missing required flags: --html, --html-file, --text, --text-file, --react-email, or --template",
        );
      }
      if (options.scheduledAt && !options.send) throw new CliError("invalid_flags", "--scheduled-at needs --send");
      const payload = { ...body, ...compact(asked), ...compact({ send: options.send || undefined, scheduledAt: options.scheduledAt }) };
      if (options.dryRun) {
        output({ object: "dry_run", payload }, globals, () => console.log(JSON.stringify(payload, null, 2)));
        return;
      }
      const api = requireClient(globals);
      const created = await withSpinner("Creating...", () => unwrap(api.broadcasts.create(payload)), globals);
      output(created, globals, () =>
        console.log(
          `${pc.green("✓")} ${options.send ? (options.scheduledAt ? "Scheduled" : "Sending") : "Created draft"} broadcast ${created.id}`,
        ),
      );
    });
  });
