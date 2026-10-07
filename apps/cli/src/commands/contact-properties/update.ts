import { Command } from "@commander-js/extra-typings";
import { runWrite } from "../../lib/actions.js";
import { requireClient, unwrap } from "../../lib/client.js";
import { helpText } from "../../lib/help.js";
import { pickProperty } from "../../lib/pickers.js";
import { promptMissing } from "../../lib/prompts.js";
import { fallback } from "./create.js";

export const update = new Command("update")
  .description("Change a contact property's fallback value")
  .argument("[id]", "Contact property ID")
  .option("--fallback-value <value>", "New fallback value")
  .addHelpText(
    "after",
    helpText({
      output: '{"object":"contact_property","id":"..."}',
      codes: ["missing_id", "missing_flags", "invalid_flag", "update_error"],
      examples: ["dispatch contact-properties update prop_123 --fallback-value starter"],
    }),
  )
  .action(async (id, options, command) => {
    await runWrite(command, {
      prepare: async (globals) => {
        const target = await pickProperty(id, globals);
        const asked = await promptMissing(
          { value: options.fallbackValue },
          [{ key: "value", flag: "--fallback-value", label: "Fallback value" }],
          globals,
        );
        // Flags are text. Read the stored type before converting a number or boolean fallback.
        const property = await unwrap<{ type?: string }>(requireClient(globals).contactProperties.get(target));
        return { id: target, fallbackValue: fallback(asked.value, property.type) };
      },
      call: (api, input) => api.contactProperties.update(input),
      done: (property: { id: string }) => `Updated contact property ${property.id}`,
    });
  });
