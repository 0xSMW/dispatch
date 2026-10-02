import { Command } from "@commander-js/extra-typings";
import { runList } from "../lib/actions.js";
import { helpText } from "../lib/help.js";
import { pageOptions } from "../lib/pagination.js";

type Entry = { id: string; type?: string; kind?: string; summary?: string; title?: string; created_at?: string; at?: string };

export const timeline = pageOptions(new Command("timeline"))
  .description("Show emails, events, inbound mail, webhooks, automations, and API logs in one feed (Dispatch only)")
  .addHelpText(
    "after",
    helpText({
      output: '{"object":"list","has_more":true,"data":[{"id":"...","type":"email.delivered","created_at":"..."}]}',
      codes: ["invalid_limit", "list_error"],
      examples: ["dispatch timeline", "dispatch timeline --limit 50 --json"],
    }),
  )
  .action(async (_options, command) => {
    await runList<Entry>(command, {
      call: (api, page) => api.timeline.list(page),
      columns: ["At", "Type", "Summary", "ID"],
      row: (entry) => [entry.created_at ?? entry.at ?? "", entry.type ?? entry.kind ?? "", entry.summary ?? entry.title ?? "", entry.id],
      empty: "(nothing yet)",
    });
  });
