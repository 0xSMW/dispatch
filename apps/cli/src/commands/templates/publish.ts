import { Command } from "@commander-js/extra-typings";
import { runWrite } from "../../lib/actions.js";
import { helpText } from "../../lib/help.js";
import { compact } from "../../lib/json.js";
import { pickTemplate } from "../../lib/pickers.js";

export const publish = new Command("publish")
  .description("Publish a template's latest draft, or a given version")
  .argument("[id]", "Template ID or alias")
  .option("--version-id <id>", "Publish this version instead of the latest draft")
  .addHelpText(
    "after",
    helpText({
      output: '{"object":"template","id":"..."}',
      codes: ["missing_id", "publish_error"],
      examples: ["dispatch templates publish welcome"],
    }),
  )
  .action(async (id, options, command) => {
    await runWrite(command, {
      code: "publish_error",
      loading: "Publishing...",
      prepare: (globals) => pickTemplate(id, globals),
      call: (api, target) => api.templates.publish(target, compact({ versionId: options.versionId })),
      done: (template: { id: string }) => `Published template ${template.id}`,
    });
  });
