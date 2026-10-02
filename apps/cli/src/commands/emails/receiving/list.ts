import { Command } from "@commander-js/extra-typings";
import { runList } from "../../../lib/actions.js";
import { helpText } from "../../../lib/help.js";
import { pageOptions } from "../../../lib/pagination.js";

export type Received = { id: string; from: string; to: string[] | string; subject: string; created_at: string };

export const list = pageOptions(new Command("list"))
  .alias("ls")
  .description("List received emails")
  .addHelpText(
    "after",
    helpText({
      output: '{"object":"list","has_more":false,"data":[{"id":"...","from":"...","to":["..."],"subject":"..."}]}',
      codes: ["invalid_limit", "invalid_pagination", "list_error"],
      examples: ["dispatch emails receiving", "dispatch emails receiving list --limit 25"],
    }),
  )
  .action(async (_options, command) => {
    await runList<Received>(command, {
      call: (api, page) => api.emails.receiving.list(page),
      columns: ["From", "To", "Subject", "Received", "ID"],
      row: (email) => [email.from, [email.to].flat().join(", "), email.subject, email.created_at, email.id],
      empty: "(no received emails)",
    });
  });
