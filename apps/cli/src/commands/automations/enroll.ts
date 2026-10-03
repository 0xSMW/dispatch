import { Command } from "@commander-js/extra-typings";
import { runWrite } from "../../lib/actions.js";
import { CliError } from "../../lib/errors.js";
import { helpText } from "../../lib/help.js";
import { pickAutomation } from "../../lib/pickers.js";
import { confirm } from "../../lib/prompts.js";

export const enroll = new Command("enroll")
  .description("Enroll existing live contacts into an enabled contact automation")
  .argument("[id]", "Automation ID")
  .option("--segment-id <id>", "Enroll contacts in this segment")
  .option("--all", "Enroll all live contacts")
  .option("--yes", "Skip the confirmation prompt")
  .addHelpText("after", helpText({
    output: '{"object":"automation_enrollment_job","id":"...","status":"queued","counts":{...}}',
    codes: ["missing_id", "missing_flags", "validation_error", "confirmation_required", "enroll_error"],
    examples: ["dispatch automations enroll auto_123 --segment-id seg_123 --yes", "dispatch automations enroll auto_123 --all --yes"],
  }))
  .action(async (id, options, command) => {
    await runWrite(command, {
      code: "enroll_error",
      prepare: async (globals) => {
        if (options.all && options.segmentId !== undefined) {
          throw new CliError("validation_error", "Choose --segment-id or --all, not both");
        }
        if (!options.all && !options.segmentId) {
          throw new CliError("missing_flags", "Choose --segment-id or --all");
        }
        const target = await pickAutomation(id, globals);
        await confirm(`Enroll existing contacts into automation ${target}? Matching flows may send email.`, options.yes, globals);
        return target;
      },
      call: (api, target) => api.automations.enroll(target, options.all ? { all: true } : { segmentId: options.segmentId! }),
    });
  });
