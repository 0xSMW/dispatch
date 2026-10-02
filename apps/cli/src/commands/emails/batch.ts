import { Command, Option } from "@commander-js/extra-typings";
import pc from "picocolors";
import { guard } from "../../lib/actions.js";
import { requireClient, unwrap } from "../../lib/client.js";
import { content } from "../../lib/content.js";
import { CliError } from "../../lib/errors.js";
import { read } from "../../lib/files.js";
import { helpText } from "../../lib/help.js";
import { compact, jsonFlag } from "../../lib/json.js";
import { output } from "../../lib/output.js";
import { withSpinner } from "../../lib/spinner.js";

type Email = Record<string, unknown>;

export const batch = new Command("batch")
  .description("Send up to 100 emails in one request")
  .option("--file <path>", "JSON array of emails, or - for stdin")
  .addOption(new Option("--emails <json>", "JSON array of emails").hideHelp())
  .option("--react-email <file>", "Render a React Email file into every email that has no body")
  .option("--props <json>", "Props for --react-email, as JSON")
  .option("--idempotency-key <key>", "Make retries of this batch safe")
  .addOption(
    new Option("--batch-validation <mode>", "strict rejects the batch on any invalid email").choices(["strict", "permissive"] as const),
  )
  .addHelpText(
    "after",
    helpText({
      output: '{"data":[{"id":"email_..."},{"id":"email_..."}]}',
      codes: ["missing_flags", "invalid_json", "file_error", "send_error", "validation_error"],
      examples: ["dispatch emails batch --file emails.json", "cat emails.json | dispatch emails batch --file -"],
    }),
  )
  .action(async (options, command) => {
    await guard(command, "send_error", async (globals) => {
      const raw = options.file ? await read(options.file) : options.emails;
      if (!raw) throw new CliError("missing_flags", "Missing required flags: --file");
      const parsed = jsonFlag<Email[] | { emails: Email[] }>(raw, options.file ? "--file" : "--emails");
      const emails = Array.isArray(parsed) ? parsed : parsed?.emails;
      if (!Array.isArray(emails) || emails.length === 0) {
        throw new CliError("invalid_json", "The batch must be a non-empty JSON array of emails");
      }
      if (options.reactEmail) {
        const { html } = await content({ reactEmail: options.reactEmail, props: options.props });
        for (const email of emails) if (!email.html && !email.text && !email.template) email.html = html;
      }
      const api = requireClient(globals);
      const sent = await withSpinner(
        "Sending...",
        () => unwrap(api.batch.send(emails, compact({ idempotencyKey: options.idempotencyKey, batchValidation: options.batchValidation }))),
        globals,
      );
      output(sent, globals, () => console.log(`${pc.green("✓")} Sent ${(sent as { data?: unknown[] }).data?.length ?? 0} emails`));
    });
  });
