import { Command } from "@commander-js/extra-typings";
import { runList } from "../../lib/actions.js";
import { helpText } from "../../lib/help.js";
import { pageOptions } from "../../lib/pagination.js";
import { pickContact } from "../../lib/pickers.js";

type Activity = {
  id: string;
  type: string;
  label?: string | null;
  automation_id?: string | null;
  run_id?: string | null;
  email_id?: string | null;
  created_at: string;
};

export const activity = pageOptions(new Command("activity"))
  .description("Show a contact's events, automation runs, and email activity (Dispatch only)")
  .argument("[id]", "Contact ID or email")
  .addHelpText(
    "after",
    helpText({
      output: '{"object":"list","has_more":false,"data":[{"id":"...","type":"email.opened","created_at":"..."}]}',
      codes: ["missing_id", "list_error"],
      examples: ["dispatch contacts activity ada@example.com"],
    }),
  )
  .action(async (id, _options, command) => {
    await runList<Activity, string>(command, {
      prepare: (globals) => pickContact(id, globals),
      call: (api, page, target) => api.contacts.activity(target, page),
      columns: ["Type", "Label", "Automation", "Run", "Email", "At", "ID"],
      row: (item) => [item.type, item.label ?? "", item.automation_id ?? "", item.run_id ?? "", item.email_id ?? "", item.created_at, item.id],
      empty: "(no activity)",
    });
  });
