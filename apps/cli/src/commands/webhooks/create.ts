import { Command } from "@commander-js/extra-typings";
import pc from "picocolors";
import { runCreate } from "../../lib/actions.js";
import { helpText } from "../../lib/help.js";
import { csv } from "../../lib/json.js";
import { promptMissing } from "../../lib/prompts.js";

export const create = new Command("create")
  .description("Create a webhook. The signing secret is shown once")
  .argument("[endpoint]", "URL that receives events")
  .option("--endpoint <url>", "URL that receives events (same as the positional argument)")
  .option("--events <types>", 'Comma-separated event types, or "all"', "all")
  .addHelpText(
    "after",
    helpText({
      output: '{"object":"webhook","id":"...","signing_secret":"whsec_..."}',
      codes: ["missing_flags", "create_error", "validation_error"],
      examples: ["dispatch webhooks create --endpoint https://acme.com/hooks --events email.delivered,email.bounced"],
    }),
  )
  .action(async (endpoint, options, command) => {
    await runCreate(command, {
      prepare: (globals) =>
        promptMissing(
          { endpoint: endpoint ?? options.endpoint },
          [{ key: "endpoint", flag: "--endpoint", label: "Endpoint URL" }],
          globals,
        ),
      call: (api, input) => api.webhooks.create({ endpoint: input.endpoint, events: csv(options.events) }),
      done: (hook: { id: string; signing_secret?: string }) => `Created webhook ${hook.id}`,
      human: (hook) => {
        if (hook.signing_secret) console.log(`Signing secret: ${pc.bold(hook.signing_secret)}`);
      },
    });
  });
