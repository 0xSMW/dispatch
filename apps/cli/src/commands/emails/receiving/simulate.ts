import { Command } from "@commander-js/extra-typings";
import { runCreate } from "../../../lib/actions.js";
import { attachments } from "../../../lib/attachments.js";
import { helpText } from "../../../lib/help.js";
import { collect, compact, jsonFlag, pairs } from "../../../lib/json.js";

export const simulate = new Command("simulate")
  .description("Create a received email locally, as if it arrived over SMTP (Dispatch only)")
  .option("--from <address>", "Sender", "sender@example.net")
  .option("--to <address>", "Recipient on a receiving domain", "inbound@example.com")
  .option("--subject <subject>", "Subject", "Inbound local test")
  .option("--text <text>", "Plain-text body")
  .option("--html <html>", "HTML body")
  .option("--headers <json-or-key=value>", "Headers as JSON, or key=value. Repeatable", collect)
  .option("--attachment <spec>", 'Attach a file: "path;cid=;type=;filename=". Repeatable', collect)
  .addHelpText(
    "after",
    helpText({
      output: '{"object":"email","id":"..."}',
      codes: ["create_error", "invalid_json"],
      examples: ['dispatch emails receiving simulate --to support@acme.com --text "Help!"'],
    }),
  )
  .action(async (options, command) => {
    await runCreate(command, {
      loading: "Simulating...",
      call: async (api) => {
        const headers = options.headers?.[0]?.trim().startsWith("{")
          ? jsonFlag<Record<string, string>>(options.headers[0], "--headers")
          : pairs(options.headers, "--headers");
        return api.emails.receiving.simulate(
          compact({
            from: options.from,
            to: options.to,
            subject: options.subject,
            text: options.text ?? (options.html ? undefined : "This received email was simulated locally."),
            html: options.html,
            headers: headers ?? {},
            attachments: (await attachments(options.attachment)) ?? [],
          }),
        );
      },
      done: (email: { id: string }) => `Simulated received email ${email.id}`,
    });
  });
