import { Command, Option } from "@commander-js/extra-typings";
import { runCreate } from "../../lib/actions.js";
import { helpText } from "../../lib/help.js";
import { promptMissing } from "../../lib/prompts.js";
import { showDomain } from "./records.js";

export const create = new Command("create")
  .description("Add a sending or receiving domain")
  .argument("[name]", "Domain name, such as example.com")
  .option("--name <domain>", "Domain name (same as the positional argument)")
  .option("--region <region>", "SES region: us-east-1, eu-west-1, sa-east-1, ap-northeast-1")
  .addOption(new Option("--tls <mode>", "TLS mode").choices(["opportunistic", "enforced"] as const))
  .option("--tracking-subdomain <subdomain>", "Subdomain for open and click tracking links")
  .option("--custom-return-path <subdomain>", "Subdomain for the MAIL FROM return path")
  .option("--open-tracking", "Track opens")
  .option("--click-tracking", "Track clicks")
  .addOption(new Option("--sending <state>", "Sending capability").choices(["enabled", "disabled"] as const))
  .addOption(new Option("--receiving <state>", "Receiving capability").choices(["enabled", "disabled"] as const))
  .addHelpText(
    "after",
    helpText({
      output: '{"object":"domain","id":"...","name":"example.com","status":"not_started","records":[...]}',
      codes: ["missing_flags", "create_error", "validation_error"],
      examples: [
        "dispatch domains create example.com",
        "dispatch domains create --name example.com --region eu-west-1 --receiving enabled",
      ],
    }),
  )
  .action(async (name, options, command) => {
    await runCreate(command, {
      prepare: (globals) =>
        promptMissing(
          { name: name ?? options.name },
          [{ key: "name", flag: "--name", label: "Domain name", placeholder: "example.com" }],
          globals,
        ),
      call: (api, input) =>
        api.domains.create({
          name: input.name,
          region: options.region,
          tls: options.tls,
          trackingSubdomain: options.trackingSubdomain,
          customReturnPath: options.customReturnPath,
          openTracking: options.openTracking,
          clickTracking: options.clickTracking,
          capabilities: options.sending || options.receiving ? { sending: options.sending, receiving: options.receiving } : undefined,
        }),
      done: (domain: { name: string; id: string; records?: [] }) => `Created domain ${domain.name} (${domain.id}). Add these DNS records:`,
      human: (domain) => showDomain(domain),
    });
  });
