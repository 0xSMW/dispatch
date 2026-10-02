import { Command, Option } from "@commander-js/extra-typings";
import { runList } from "../../lib/actions.js";
import { helpText } from "../../lib/help.js";
import { compact } from "../../lib/json.js";
import { pageOptions } from "../../lib/pagination.js";
import { pickBroadcast } from "../../lib/pickers.js";

type Recipient = { id: string; email: string; status?: string; created_at?: string };

const types = ["sent", "delivered", "opened", "clicked", "bounced", "complained", "unsubscribed", "suppressed"] as const;

export const recipients = pageOptions(new Command("recipients"))
  .description("List a broadcast's recipients by outcome")
  .argument("[id]", "Broadcast ID")
  .addOption(new Option("--type <type>", "Which recipients").choices(types).default("sent" as (typeof types)[number]))
  .option("--email <email>", "Only this recipient")
  .option("--bounce-type <type>", "With --type bounced, only this bounce type")
  .addHelpText(
    "after",
    helpText({
      output: '{"object":"list","has_more":false,"data":[{"id":"...","email":"ada@example.com"}]}',
      codes: ["missing_id", "list_error"],
      examples: ["dispatch broadcasts recipients bc_123 --type bounced"],
    }),
  )
  .action(async (id, options, command) => {
    await runList<Recipient, string>(command, {
      prepare: (globals) => pickBroadcast(id, globals),
      call: (api, page, target) =>
        api.broadcasts.recipients(target, {
          type: options.type,
          ...compact({ email: options.email, bounceType: options.bounceType }),
          ...page,
        }),
      columns: ["Email", "Status", "At", "ID"],
      row: (item) => [item.email, item.status ?? options.type, item.created_at ?? "", item.id],
      empty: "(no recipients)",
    });
  });
