import { Command } from "@commander-js/extra-typings";
import { runGet } from "../../lib/actions.js";
import { helpText } from "../../lib/help.js";
import { pickDomain } from "../../lib/pickers.js";
import { showDomain } from "./records.js";

export const get = new Command("get")
  .description("Show a domain and its DNS records")
  .argument("[id]", "Domain ID")
  .addHelpText(
    "after",
    helpText({
      output: '{"object":"domain","id":"...","name":"example.com","status":"verified","records":[...]}',
      codes: ["missing_id", "fetch_error", "not_found"],
      examples: ["dispatch domains get domain_123"],
    }),
  )
  .action(async (id, _options, command) => {
    await runGet(command, {
      prepare: (globals) => pickDomain(id, globals),
      call: (api, target) => api.domains.get(target),
      human: (domain) => showDomain(domain),
    });
  });
