import { Option } from "@commander-js/extra-typings";
import pc from "picocolors";
import { guard } from "../../lib/actions.js";
import { attachments } from "../../lib/attachments.js";
import { requireClient, unwrap } from "../../lib/client.js";
import { content, contentCommand } from "../../lib/content.js";
import { CliError } from "../../lib/errors.js";
import { helpText } from "../../lib/help.js";
import { collect, compact, jsonFlag, many, pairs } from "../../lib/json.js";
import { output } from "../../lib/output.js";
import { promptMissing } from "../../lib/prompts.js";
import { withSpinner } from "../../lib/spinner.js";

export const send = contentCommand("send")
  .description("Send an email")
  .option("--from <address>", 'Sender, such as "Acme <hello@acme.com>"')
  .option("--to <address>", "Recipient. Repeat or comma-separate for several", collect)
  .option("--cc <address>", "CC recipient. Repeatable", collect)
  .option("--bcc <address>", "BCC recipient. Repeatable", collect)
  .option("--reply-to <address>", "Reply-To address. Repeatable", collect)
  .option("--subject <subject>", "Subject line")
  .option("--template <id-or-alias>", "Send a published template instead of a body")
  .option("--var <key=value>", "Template variable. Repeatable", collect)
  .addOption(new Option("--variables <json>", "Template variables as JSON").hideHelp())
  .option("--headers <key=value>", "Custom header. Repeatable", collect)
  .option("--tags <name=value>", "Tag. Repeatable", collect)
  .option("--scheduled-at <time>", 'Send later: an ISO time or natural language such as "in 1 hour"')
  .option("--topic-id <id>", "Topic for unsubscribe handling")
  .option("--attachment <spec>", 'Attach a file: "path;cid=logo;type=image/png;filename=logo.png". Repeatable', collect)
  .option("--attachments-file <path>", "JSON array of attachments, or - for stdin")
  .addOption(new Option("--attachment-type <type>", "Content type for every --attachment").hideHelp())
  .option("--idempotency-key <key>", "Make retries of this send safe")
  .option("--dry-run", "Print what would be sent, in the SDK's field names, without sending")
  .addHelpText(
    "after",
    helpText({
      output: '{"id":"email_..."}',
      codes: ["missing_flags", "invalid_flags", "invalid_json", "react_email_build_error", "validation_error", "send_error"],
      examples: [
        'dispatch emails send --from hello@acme.com --to you@example.com --subject Hi --text "Hello"',
        "dispatch emails send --from hello@acme.com --to you@example.com --template password-reset --var ACTION_URL=https://acme.com/r/1",
        'dispatch emails send --from hello@acme.com --to you@example.com --react-email emails/welcome.tsx --props \'{"name":"Ada"}\'',
        "cat body.html | dispatch emails send --from hello@acme.com --to you@example.com --subject Hi --html-file -",
      ],
    }),
  )
  .action(async (options, command) => {
    await guard(command, "send_error", async (globals) => {
      const body = await content(options);
      const template = options.template;
      const subject = options.subject ?? body.subject;
      // A template can carry its own sender, so --from is only required without one.
      const fields = [
        ...(template ? [] : [{ key: "from" as const, flag: "--from", label: "From", placeholder: "hello@example.com" }]),
        { key: "to" as const, flag: "--to", label: "To", placeholder: "you@example.com" },
        ...(template ? [] : [{ key: "subject" as const, flag: "--subject", label: "Subject" }]),
      ];
      const asked = await promptMissing({ from: options.from, to: many(options.to)?.join(","), subject }, fields, globals);
      let text = body.text;
      if (!template && !body.html && !text) {
        const filled = await promptMissing(
          { text },
          [{ key: "text", flag: "--text, --html, --html-file, --react-email, or --template", label: "Message" }],
          globals,
        );
        text = filled.text;
      }
      const variables = { ...jsonFlag<Record<string, unknown>>(options.variables, "--variables"), ...pairs(options.var, "--var") };
      if (!template && Object.keys(variables).length) throw new CliError("invalid_flags", "--var needs --template");
      const payload = compact({
        from: asked.from,
        to: many([asked.to]),
        cc: many(options.cc),
        bcc: many(options.bcc),
        replyTo: many(options.replyTo),
        subject: asked.subject || undefined,
        ...(template ? { template: { id: template, variables } } : { html: body.html, text }),
        headers: pairs(options.headers, "--headers"),
        tags: pairs(options.tags, "--tags"),
        scheduledAt: options.scheduledAt,
        topicId: options.topicId,
        attachments: await attachments(options.attachment, options.attachmentsFile, options.attachmentType),
      });
      if (options.dryRun) {
        output({ object: "dry_run", payload }, globals, () => console.log(JSON.stringify(payload, null, 2)));
        return;
      }
      const api = requireClient(globals);
      const sent = await withSpinner(
        "Sending...",
        () => unwrap(api.emails.send(payload, compact({ idempotencyKey: options.idempotencyKey }))),
        globals,
      );
      output(sent, globals, () => console.log(`${pc.green("✓")} ${options.scheduledAt ? "Scheduled" : "Sent"} email ${sent.id}`));
    });
  });
