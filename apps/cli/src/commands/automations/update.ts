import { Command, Option } from "@commander-js/extra-typings";
import { runWrite } from "../../lib/actions.js";
import { helpText } from "../../lib/help.js";
import { compact, jsonFlag } from "../../lib/json.js";
import { pickAutomation } from "../../lib/pickers.js";

export const update = new Command("update")
  .description("Start, pause, resume, or stop an automation, or change its definition")
  .argument("[id]", "Automation ID")
  .addOption(new Option("--status <status>", "enabled resumes, paused holds runs, disabled stops runs").choices(["enabled", "paused", "disabled"] as const))
  .addOption(new Option("--reentry <mode>", "Whether a contact can enter once or every time").choices(["once", "every_time"] as const))
  .option("--name <name>", "New name")
  .option("--trigger <event>", "New event trigger name (use --steps for contact triggers)")
  .option("--steps <json>", "Steps as a JSON array")
  .option("--connections <json>", "Connections as a JSON array")
  .option("--dry-run", "Validate the update and count stranded runs without saving changes")
  .addHelpText(
    "after",
    helpText({
      output: '{"object":"automation","id":"..."} or, with --dry-run, {"stranded_runs":0,"by_step":{}}',
      codes: ["missing_id", "invalid_json", "update_error"],
      examples: [
        "dispatch automations update auto_123 --status paused",
        "dispatch automations update auto_123 --status enabled",
        "dispatch automations update auto_123 --status disabled",
        "dispatch automations update auto_123 --trigger user.activated",
        'dispatch automations update auto_123 --steps "$STEPS" --connections "$CONNECTIONS" --dry-run',
      ],
    }),
  )
  .action(async (id, options, command) => {
    await runWrite(command, {
      loading: options.dryRun ? "Previewing..." : "Saving...",
      prepare: (globals) => pickAutomation(id, globals),
      call: (api, target) => {
        const payload = compact({
          status: options.status,
          reentry: options.reentry,
          name: options.name,
          trigger: options.trigger,
          steps: jsonFlag<unknown[]>(options.steps, "--steps"),
          connections: jsonFlag<unknown[]>(options.connections, "--connections"),
        });
        return options.dryRun
          ? api.automations.dryRun(target, payload)
          : api.automations.update(target, payload);
      },
      done: (result: { id: string } | { stranded_runs: number }) => "stranded_runs" in result
        ? `Preview: ${result.stranded_runs} runs would stop. No changes saved.`
        : `Updated automation ${result.id}`,
    });
  });
