import { Command } from "@commander-js/extra-typings";
import { runWrite } from "../../lib/actions.js";
import { contactRef } from "../../lib/commands.js";
import { helpText } from "../../lib/help.js";
import { compact, jsonFlag } from "../../lib/json.js";
import { pickContact } from "../../lib/pickers.js";

export const update = new Command("update")
  .description("Update a contact")
  .argument("[id]", "Contact ID or email")
  .option("--first-name <name>", "First name")
  .option("--last-name <name>", "Last name")
  .option("--unsubscribed", "Unsubscribe from everything")
  .option("--no-unsubscribed", "Resubscribe")
  .option("--properties <json>", "Custom properties as JSON")
  .addHelpText(
    "after",
    helpText({
      output: '{"object":"contact","id":"..."}',
      codes: ["missing_id", "invalid_json", "update_error"],
      examples: [
        "dispatch contacts update ada@example.com --unsubscribed",
        'dispatch contacts update ct_123 --properties \'{"plan":"pro"}\'',
      ],
    }),
  )
  .action(async (id, options, command) => {
    await runWrite(command, {
      prepare: (globals) => pickContact(id, globals),
      call: (api, target) =>
        api.contacts.update({
          ...contactRef(target),
          ...compact({
            firstName: options.firstName,
            lastName: options.lastName,
            unsubscribed: options.unsubscribed,
            properties: jsonFlag<Record<string, unknown>>(options.properties, "--properties"),
          }),
        }),
      done: (contact: { id: string }) => `Updated contact ${contact.id}`,
    });
  });
