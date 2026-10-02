import { Command, Option } from "@commander-js/extra-typings";
import { runWrite } from "../../lib/actions.js";
import { helpText } from "../../lib/help.js";
import { compact } from "../../lib/json.js";
import { pickDomain } from "../../lib/pickers.js";

export const update = new Command("update")
  .description("Change a domain's tracking and TLS settings")
  .argument("[id]", "Domain ID")
  .addOption(new Option("--tls <mode>", "TLS mode").choices(["opportunistic", "enforced"] as const))
  .option("--open-tracking", "Track opens")
  .option("--no-open-tracking", "Stop tracking opens")
  .option("--click-tracking", "Track clicks")
  .option("--no-click-tracking", "Stop tracking clicks")
  .option("--tracking-subdomain <subdomain>", "Subdomain for tracking links")
  .addHelpText(
    "after",
    helpText({
      output: '{"object":"domain","id":"..."}',
      codes: ["missing_id", "update_error", "validation_error"],
      examples: ["dispatch domains update domain_123 --open-tracking --tls enforced"],
    }),
  )
  .action(async (id, options, command) => {
    await runWrite(command, {
      prepare: (globals) => pickDomain(id, globals),
      call: (api, target) =>
        api.domains.update({
          id: target,
          ...compact({
            tls: options.tls,
            openTracking: options.openTracking,
            clickTracking: options.clickTracking,
            trackingSubdomain: options.trackingSubdomain,
          }),
        }),
      done: (domain: { id: string }) => `Updated domain ${domain.id}`,
    });
  });
