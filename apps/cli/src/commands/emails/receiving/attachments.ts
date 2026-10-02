import { Command } from "@commander-js/extra-typings";
import { runList } from "../../../lib/actions.js";
import { helpText } from "../../../lib/help.js";
import { pageOptions } from "../../../lib/pagination.js";
import { pickReceived } from "../../../lib/pickers.js";
import type { Attachment } from "../attachments.js";

export const attachments = pageOptions(new Command("attachments"))
  .description("List a received email's attachments")
  .argument("[id]", "Received email ID")
  .addHelpText(
    "after",
    helpText({
      output: '{"object":"list","has_more":false,"data":[{"id":"...","filename":"...","content_type":"..."}]}',
      codes: ["missing_id", "list_error"],
      examples: ["dispatch emails receiving attachments rcv_123"],
    }),
  )
  .action(async (id, _options, command) => {
    await runList<Attachment, string>(command, {
      prepare: (globals) => pickReceived(id, globals),
      call: (api, page, emailId) => api.emails.receiving.attachments.list({ emailId, ...page }),
      columns: ["Filename", "Type", "Size", "ID"],
      row: (item) => [item.filename, item.content_type, item.size ?? "", item.id],
      empty: "(no attachments)",
    });
  });
