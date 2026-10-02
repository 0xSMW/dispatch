import { Command } from "@commander-js/extra-typings";
import { runList } from "../../lib/actions.js";
import { helpText } from "../../lib/help.js";
import { compact } from "../../lib/json.js";
import { pageOptions } from "../../lib/pagination.js";

type Contact = {
  id: string;
  email: string;
  first_name?: string | null;
  last_name?: string | null;
  unsubscribed: boolean;
  created_at: string;
};

export const list = pageOptions(new Command("list"))
  .alias("ls")
  .description("List contacts")
  .option("--segment-id <id>", "Only contacts in this segment")
  .addHelpText(
    "after",
    helpText({
      output: '{"object":"list","has_more":false,"data":[{"id":"...","email":"ada@example.com","unsubscribed":false}]}',
      codes: ["invalid_limit", "invalid_pagination", "list_error"],
      examples: ["dispatch contacts", "dispatch contacts list --segment-id seg_123 --limit 100"],
    }),
  )
  .action(async (options, command) => {
    await runList<Contact>(command, {
      call: (api, page) => api.contacts.list({ ...page, ...compact({ segmentId: options.segmentId }) }),
      columns: ["Email", "Name", "Unsubscribed", "Created", "ID"],
      row: (contact) => [
        contact.email,
        [contact.first_name, contact.last_name].filter(Boolean).join(" "),
        contact.unsubscribed ? "yes" : "no",
        contact.created_at,
        contact.id,
      ],
      empty: "(no contacts)",
    });
  });
