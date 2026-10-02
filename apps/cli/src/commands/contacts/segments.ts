import { Command } from "@commander-js/extra-typings";
import { runList } from "../../lib/actions.js";
import { contactRef } from "../../lib/commands.js";
import { helpText } from "../../lib/help.js";
import { pageOptions } from "../../lib/pagination.js";
import { pickContact } from "../../lib/pickers.js";

type Segment = { id: string; name: string; created_at?: string };

export const segments = pageOptions(new Command("segments"))
  .description("List the segments a contact belongs to")
  .argument("[id]", "Contact ID or email")
  .addHelpText(
    "after",
    helpText({
      output: '{"object":"list","has_more":false,"data":[{"id":"...","name":"Customers"}]}',
      codes: ["missing_id", "list_error"],
      examples: ["dispatch contacts segments ada@example.com"],
    }),
  )
  .action(async (id, _options, command) => {
    await runList<Segment, string>(command, {
      prepare: (globals) => pickContact(id, globals),
      call: (api, page, target) => api.contacts.segments.list({ ...contactRef(target), ...page }),
      columns: ["Name", "ID"],
      row: (segment) => [segment.name, segment.id],
      empty: "(no segments)",
    });
  });
