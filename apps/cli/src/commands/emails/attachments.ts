import { Command } from "@commander-js/extra-typings";
import { runList } from "../../lib/actions.js";
import { helpText } from "../../lib/help.js";
import { pageOptions } from "../../lib/pagination.js";
import { pickEmail } from "../../lib/pickers.js";

export type Attachment = { id: string; filename: string; content_type: string; size?: number; content_disposition?: string };

export const attachments = pageOptions(new Command("attachments"))
  .description("List a sent email's attachments")
  .argument("[id]", "Email ID")
  .addHelpText(
    "after",
    helpText({
      output: '{"object":"list","has_more":false,"data":[{"id":"...","filename":"invoice.pdf","content_type":"application/pdf"}]}',
      codes: ["missing_id", "list_error"],
      examples: ["dispatch emails attachments email_123"],
    }),
  )
  .action(async (id, _options, command) => {
    await runList<Attachment, string>(command, {
      prepare: (globals) => pickEmail(id, globals),
      call: (api, page, emailId) => api.emails.attachments.list({ emailId, ...page }),
      columns: ["Filename", "Type", "Size", "ID"],
      row: (item) => [item.filename, item.content_type, item.size ?? "", item.id],
      empty: "(no attachments)",
    });
  });
