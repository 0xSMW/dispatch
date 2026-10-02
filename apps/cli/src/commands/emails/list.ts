import { Command } from "@commander-js/extra-typings";
import { runList } from "../../lib/actions.js";
import { helpText } from "../../lib/help.js";
import { compact } from "../../lib/json.js";
import { pageOptions } from "../../lib/pagination.js";

type Email = { id: string; to: string[]; subject: string; last_event: string; created_at: string };

export const list = pageOptions(new Command("list"))
  .alias("ls")
  .description("List sent emails")
  .option("--status <status>", "Only emails whose last event is this status")
  .option("--query <text>", "Search by recipient or subject")
  .addHelpText(
    "after",
    helpText({
      output: '{"object":"list","has_more":true,"data":[{"id":"email_...","to":["..."],"subject":"...","last_event":"delivered"}]}',
      codes: ["invalid_limit", "invalid_pagination", "list_error"],
      examples: ["dispatch emails", "dispatch emails list --limit 50 --status bounced", "dispatch emails list --json | jq .data"],
    }),
  )
  .action(async (options, command) => {
    await runList<Email>(command, {
      call: (api, page) => api.emails.list({ ...page, ...compact({ status: options.status, q: options.query }) }),
      columns: ["To", "Subject", "Status", "Created", "ID"],
      row: (email) => [[email.to].flat().join(", "), email.subject, email.last_event, email.created_at, email.id],
      empty: "(no emails)",
    });
  });
