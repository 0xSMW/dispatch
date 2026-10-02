import { Command } from "@commander-js/extra-typings";
import { runList } from "../../lib/actions.js";
import { helpText } from "../../lib/help.js";
import { pageOptions } from "../../lib/pagination.js";
import { pickEmail } from "../../lib/pickers.js";

type Event = { id: string; type: string; created_at: string; data?: unknown };

export const events = pageOptions(new Command("events"))
  .description("Show an email's event timeline (Dispatch only)")
  .argument("[id]", "Email ID")
  .addHelpText(
    "after",
    helpText({
      output: '{"object":"list","has_more":false,"data":[{"id":"...","type":"delivered","created_at":"..."}]}',
      codes: ["missing_id", "list_error"],
      examples: ["dispatch emails events email_123"],
    }),
  )
  .action(async (id, _options, command) => {
    await runList<Event, string>(command, {
      prepare: (globals) => pickEmail(id, globals),
      call: (api, page, emailId) => api.emails.events(emailId, page),
      columns: ["Type", "Created", "ID"],
      row: (event) => [event.type, event.created_at, event.id],
      empty: "(no events)",
    });
  });
