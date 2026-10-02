import { Command } from "@commander-js/extra-typings";
import { runGet, runList } from "../../lib/actions.js";
import { helpText } from "../../lib/help.js";
import { pageOptions } from "../../lib/pagination.js";

type Fired = { id: string; name?: string; event?: string; email?: string | null; contact_id?: string | null; created_at: string };

// Fired events: `events history` lists them, `events history <id>` shows one.
export const history = pageOptions(new Command("history"))
  .description("List fired events, or show one (Dispatch only)")
  .argument("[id]", "Fired event ID")
  .addHelpText(
    "after",
    helpText({
      output: '{"object":"list","has_more":false,"data":[{"id":"...","name":"user.created","email":"ada@example.com"}]}',
      codes: ["invalid_limit", "list_error", "fetch_error"],
      examples: ["dispatch events history", "dispatch events history evt_123"],
    }),
  )
  .action(async (id, _options, command) => {
    if (id) {
      await runGet(command, { call: (api) => api.events.fired.get(id) });
      return;
    }
    await runList<Fired>(command, {
      call: (api, page) => api.events.fired.list(page),
      columns: ["Event", "Contact", "At", "ID"],
      row: (item) => [item.name ?? item.event ?? "", item.email ?? item.contact_id ?? "", item.created_at, item.id],
      empty: "(no fired events)",
    });
  });
