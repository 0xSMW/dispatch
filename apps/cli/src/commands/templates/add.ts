import { Command } from "@commander-js/extra-typings";
import { runCreate } from "../../lib/actions.js";
import { helpText } from "../../lib/help.js";
import { pick } from "../../lib/prompts.js";

export const add = new Command("add")
  .description("Install a library template into your templates, published (Dispatch only)")
  .argument("[slug]", "Library slug, such as password-reset")
  .addHelpText(
    "after",
    helpText({
      output: '{"object":"template","id":"..."}',
      codes: ["missing_id", "create_error", "conflict"],
      examples: ["dispatch templates add password-reset"],
    }),
  )
  .action(async (slug, _options, command) => {
    await runCreate(command, {
      loading: "Installing...",
      prepare: (globals) =>
        pick<{ id: string; slug: string; name?: string }>(slug, {
          globals,
          noun: "library template",
          list: async (api) => {
            const result = await api.templates.library.list();
            return result.error
              ? result
              : { ...result, data: { data: result.data.data.map((entry: { slug: string }) => ({ ...entry, id: entry.slug })) } };
          },
          label: (entry) => entry.name ?? entry.slug,
        }),
      call: (api, target) => api.templates.library.install(target),
      done: (template: { id: string }) => `Installed template ${template.id}`,
    });
  });
