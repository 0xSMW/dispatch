import { Command } from "@commander-js/extra-typings";
import { runWrite } from "../../../lib/actions.js";
import { confirm, pick } from "../../../lib/prompts.js";

export const cancel = new Command("cancel")
  .description("Cancel a contact import between batches")
  .argument("[id]", "Import ID")
  .option("--yes", "Skip the confirmation prompt")
  .action(async (id, options, command) => {
    await runWrite(command, {
      code: "cancel_error",
      prepare: async (globals) => {
        const target = await pick<{ id: string; filename?: string; status: string }>(id, {
          globals,
          noun: "import",
          list: (api) => api.contacts.imports.list({ limit: 100 }),
          label: (item) => `${item.filename ?? item.id} (${item.status})`,
        });
        await confirm(`Cancel contact import ${target}? Already-applied changes and runs remain.`, options.yes, globals);
        return target;
      },
      call: (api, target) => api.contacts.imports.cancel(target),
    });
  });
