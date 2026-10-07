import { Command } from "@commander-js/extra-typings";
import { runGet, runWrite } from "../../../lib/actions.js";
import { CliError } from "../../../lib/errors.js";
import { helpText } from "../../../lib/help.js";
import { pickAutomation } from "../../../lib/pickers.js";
import { confirm } from "../../../lib/prompts.js";

const get = new Command("get")
  .description("Show an enrollment job and its counts")
  .argument("[automationId]", "Automation ID")
  .argument("[jobId]", "Enrollment job ID")
  .option("--automation-id <id>", "Automation ID")
  .option("--job-id <id>", "Enrollment job ID")
  .action(async (automationId, jobId, options, command) => {
    await runGet(command, {
      prepare: async (globals) => {
        const job = jobId ?? options.jobId;
        if (!job) throw new CliError("missing_id", "Missing enrollment job id");
        return { automation: await pickAutomation(automationId ?? options.automationId, globals), job };
      },
      call: (api, target) => api.automations.getEnrollmentJob(target.automation, target.job),
    });
  });

const cancel = new Command("cancel")
  .description("Cancel enrollment between batches without cancelling created runs")
  .argument("[automationId]", "Automation ID")
  .argument("[jobId]", "Enrollment job ID")
  .option("--automation-id <id>", "Automation ID")
  .option("--job-id <id>", "Enrollment job ID")
  .option("--yes", "Skip the confirmation prompt")
  .action(async (automationId, jobId, options, command) => {
    await runWrite(command, {
      code: "cancel_error",
      prepare: async (globals) => {
        const job = jobId ?? options.jobId;
        if (!job) throw new CliError("missing_id", "Missing enrollment job id");
        const automation = await pickAutomation(automationId ?? options.automationId, globals);
        await confirm(`Cancel enrollment job ${job}? Already-created runs will continue.`, options.yes, globals);
        return { automation, job };
      },
      call: (api, target) => api.automations.cancelEnrollmentJob(target.automation, target.job),
    });
  });

export const enrollJobs = new Command("enroll-jobs")
  .description("Inspect or cancel automation enrollment jobs")
  .addHelpText("after", helpText({ examples: [
    "dispatch automations enroll-jobs get auto_123 job_123",
    "dispatch automations enroll-jobs cancel auto_123 job_123 --yes",
  ] }))
  .addCommand(get)
  .addCommand(cancel);
