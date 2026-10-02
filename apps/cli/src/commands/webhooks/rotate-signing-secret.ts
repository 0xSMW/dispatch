import { Command } from "@commander-js/extra-typings";
import pc from "picocolors";
import { runWrite } from "../../lib/actions.js";
import { helpText } from "../../lib/help.js";
import { pickWebhook } from "../../lib/pickers.js";

export const rotate = new Command("rotate-signing-secret")
  .description("Issue a new signing secret for a webhook")
  .argument("[id]", "Webhook ID")
  .addHelpText(
    "after",
    helpText({
      output: '{"object":"webhook","id":"...","signing_secret":"whsec_..."}',
      codes: ["missing_id", "rotate_error"],
      examples: ["dispatch webhooks rotate-signing-secret wh_123"],
    }),
  )
  .action(async (id, _options, command) => {
    await runWrite(command, {
      code: "rotate_error",
      prepare: (globals) => pickWebhook(id, globals),
      call: (api, target) => api.webhooks.rotateSigningSecret(target),
      done: (hook: { id: string; signing_secret?: string }) => `Rotated the signing secret for ${hook.id}`,
      human: (hook) => {
        if (hook.signing_secret) console.log(`Signing secret: ${pc.bold(hook.signing_secret)}`);
      },
    });
  });
