import { Command, Option } from "@commander-js/extra-typings";
import { runWrite } from "../../lib/actions.js";
import { helpText } from "../../lib/help.js";
import { compact, jsonFlag } from "../../lib/json.js";
import { pickAutomation } from "../../lib/pickers.js";

export const update = new Command("update")
  .description("Turn an automation on or off, or change its definition")
  .argument("[id]", "Automation ID")
  .addOption(new Option("--status <status>", "enabled or disabled").choices(["enabled", "disabled"] as const))
  .addOption(new Option("--reentry <mode>", "Whether a contact can enter once or every time").choices(["once", "every_time"] as const))
  .option("--name <name>", "New name")
  .option("--trigger <event>", "New event trigger name (use --steps for contact triggers)")
  .option("--steps <json>", "Steps as a JSON array")
  .option("--connections <json>", "Connections as a JSON array")
  .addHelpText(
    "after",
    helpText({
      output: '{"object":"automation","id":"..."}',
      codes: ["missing_id", "invalid_json", "update_error"],
      examples: [
        "dispatch automations update auto_123 --status disabled",
        "dispatch automations update auto_123 --trigger user.activated",
      ],
    }),
  )
  .action(async (id, options, command) => {
    await runWrite(command, {
      prepare: (globals) => pickAutomation(id, globals),
      call: (api, target) =>
        api.automations.update(
          target,
          compact({
            status: options.status,
            reentry: options.reentry,
            name: options.name,
            trigger: options.trigger,
            steps: jsonFlag<unknown[]>(options.steps, "--steps"),
            connections: jsonFlag<unknown[]>(options.connections, "--connections"),
          }),
        ),
      done: (automation: { id: string }) => `Updated automation ${automation.id}`,
    });
  });
