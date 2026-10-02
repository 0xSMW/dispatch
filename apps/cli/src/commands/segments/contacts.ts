import { Command } from "@commander-js/extra-typings";
import { runList } from "../../lib/actions.js";
import { helpText } from "../../lib/help.js";
import { pageOptions } from "../../lib/pagination.js";
import { pickSegment } from "../../lib/pickers.js";

type Contact = { id: string; email: string; created_at?: string };

export const contacts = pageOptions(new Command("contacts"))
  .description("List the contacts in a segment")
  .argument("[id]", "Segment ID")
  .addHelpText(
    "after",
    helpText({
      output: '{"object":"list","has_more":false,"data":[{"id":"...","email":"ada@example.com"}]}',
      codes: ["missing_id", "list_error"],
      examples: ["dispatch segments contacts seg_123 --limit 100"],
    }),
  )
  .action(async (id, _options, command) => {
    await runList<Contact, string>(command, {
      prepare: (globals) => pickSegment(id, globals),
      call: (api, page, target) => api.segments.contacts(target, page),
      columns: ["Email", "Added", "ID"],
      row: (contact) => [contact.email, contact.created_at ?? "", contact.id],
      empty: "(no contacts)",
    });
  });
