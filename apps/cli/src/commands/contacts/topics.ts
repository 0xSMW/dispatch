import { Command } from "@commander-js/extra-typings";
import { runList } from "../../lib/actions.js";
import { contactRef } from "../../lib/commands.js";
import { helpText } from "../../lib/help.js";
import { pageOptions } from "../../lib/pagination.js";
import { pickContact } from "../../lib/pickers.js";

type Topic = { id: string; name: string; subscription: string };

export const topics = pageOptions(new Command("topics"))
  .description("List a contact's topic subscriptions")
  .argument("[id]", "Contact ID or email")
  .addHelpText(
    "after",
    helpText({
      output: '{"object":"list","has_more":false,"data":[{"id":"...","name":"Product updates","subscription":"opt_in"}]}',
      codes: ["missing_id", "list_error"],
      examples: ["dispatch contacts topics ada@example.com"],
    }),
  )
  .action(async (id, _options, command) => {
    await runList<Topic, string>(command, {
      prepare: (globals) => pickContact(id, globals),
      call: (api, page, target) => api.contacts.topics.list({ ...contactRef(target), ...page }),
      columns: ["Topic", "Subscription", "ID"],
      row: (topic) => [topic.name, topic.subscription, topic.id],
      empty: "(no topics)",
    });
  });
