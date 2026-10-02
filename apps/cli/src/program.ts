import { Command, type CommandUnknownOpts } from "@commander-js/extra-typings";
import { apiKeys } from "./commands/api-keys/index.js";
import { auth } from "./commands/auth/index.js";
import { login } from "./commands/auth/login.js";
import { logout } from "./commands/auth/logout.js";
import { automations } from "./commands/automations/index.js";
import { broadcasts } from "./commands/broadcasts/index.js";
import { commands } from "./commands/commands.js";
import { completion } from "./commands/completion.js";
import { contactProperties } from "./commands/contact-properties/index.js";
import { contacts } from "./commands/contacts/index.js";
import { dev } from "./commands/dev/index.js";
import { doctor } from "./commands/doctor.js";
import { domains } from "./commands/domains/index.js";
import { emails } from "./commands/emails/index.js";
import { events } from "./commands/events/index.js";
import { logs } from "./commands/logs/index.js";
import { open } from "./commands/open.js";
import { segments } from "./commands/segments/index.js";
import { suppressions } from "./commands/suppressions/index.js";
import { system } from "./commands/system.js";
import { tail } from "./commands/tail.js";
import { templates } from "./commands/templates/index.js";
import { timeline } from "./commands/timeline.js";
import { topics } from "./commands/topics/index.js";
import { usage } from "./commands/usage.js";
import { webhooks } from "./commands/webhooks/index.js";
import { whoami } from "./commands/whoami.js";
import { version } from "./lib/client.js";
import { helpText } from "./lib/help.js";

// Old top-level names (send, keys, listen, ...) are rewritten in lib/legacy.ts before parsing.
export const program = new Command("dispatch")
  .description("Dispatch CLI: send and manage email through your Dispatch API")
  .version(`dispatch-cli v${version}`, "-v, --version")
  .option("--api-key <key>", "API key (overrides env and saved profile)")
  .option("--api-url <url>", "API base URL (overrides env and saved profile)")
  .option("-p, --profile <name>", "Profile to use (overrides DISPATCH_PROFILE)")
  .option("--json", "Force JSON output")
  .option("-q, --quiet", "Suppress spinners and status output (implies --json)")
  .addHelpText(
    "after",
    helpText({
      globals: false,
      examples: [
        "dispatch login",
        "dispatch emails send --from hello@acme.com --to you@example.com --subject Hi --text Hello",
        "dispatch domains",
        "dispatch doctor",
      ],
    }),
  )
  .hook("preAction", (root) => {
    if (root.opts().quiet) root.setOptionValue("json", true);
  })
  .addCommand(emails)
  .addCommand(domains)
  .addCommand(apiKeys)
  .addCommand(webhooks)
  .addCommand(templates)
  .addCommand(broadcasts)
  .addCommand(contacts)
  .addCommand(contactProperties)
  .addCommand(segments)
  .addCommand(topics)
  .addCommand(suppressions)
  .addCommand(automations)
  .addCommand(events)
  .addCommand(logs)
  .addCommand(login())
  .addCommand(logout())
  .addCommand(whoami)
  .addCommand(auth)
  .addCommand(doctor)
  .addCommand(usage)
  .addCommand(open)
  .addCommand(commands)
  .addCommand(completion)
  .addCommand(dev)
  .addCommand(tail)
  .addCommand(timeline)
  .addCommand(system);

// Commander's own usage errors (unknown option, missing value) follow the same
// JSON error shape as every other failure when output is JSON.
function usageErrors(command: CommandUnknownOpts) {
  command.configureOutput({
    outputError: (message, write) => {
      const argv = process.argv;
      const json = argv.includes("--json") || argv.includes("-q") || argv.includes("--quiet") || !process.stdout.isTTY;
      if (!json) return write(message);
      const text = message.replace(/^error:\s*/, "").trim();
      write(`${JSON.stringify({ error: { message: text, code: "invalid_usage" } }, null, 2)}\n`);
    },
  });
  for (const child of command.commands) usageErrors(child);
}

usageErrors(program);
