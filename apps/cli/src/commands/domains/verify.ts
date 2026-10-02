import { Command } from "@commander-js/extra-typings";
import { runWrite } from "../../lib/actions.js";
import { helpText } from "../../lib/help.js";
import { pickDomain } from "../../lib/pickers.js";

export const verify = new Command("verify")
  .description("Start DNS verification for a domain")
  .argument("[id]", "Domain ID")
  .addHelpText(
    "after",
    helpText({
      output: '{"object":"domain","id":"..."}',
      codes: ["missing_id", "verify_error", "not_found"],
      examples: ["dispatch domains verify domain_123"],
    }),
  )
  .action(async (id, _options, command) => {
    await runWrite(command, {
      code: "verify_error",
      loading: "Verifying...",
      prepare: (globals) => pickDomain(id, globals),
      call: (api, target) => api.domains.verify(target),
      done: (domain: { id: string; status?: string }) =>
        `Verification started for ${domain.id}${domain.status ? ` (${domain.status})` : ""}`,
    });
  });
