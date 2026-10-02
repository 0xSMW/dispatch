import { Command } from "@commander-js/extra-typings";
import { runGet } from "../../lib/actions.js";
import { helpText } from "../../lib/help.js";
import { renderTable } from "../../lib/table.js";

type Entry = { slug: string; name?: string; category?: string; set?: number; description?: string };

export const library = new Command("library")
  .description("List the default template library (Dispatch only)")
  .addHelpText(
    "after",
    helpText({
      output: '{"object":"list","has_more":false,"data":[{"slug":"password-reset","name":"Password reset","category":"auth"}]}',
      codes: ["fetch_error"],
      examples: ["dispatch templates library", "dispatch templates add password-reset"],
    }),
  )
  .action(async (_options, command) => {
    await runGet(command, {
      call: (api) => api.templates.library.list(),
      human: (result: { data: Entry[] }) =>
        console.log(
          renderTable(
            ["Slug", "Name", "Category", "Description"],
            result.data.map((entry) => [entry.slug, entry.name ?? "", entry.category ?? "", entry.description ?? ""]),
          ),
        ),
    });
  });
