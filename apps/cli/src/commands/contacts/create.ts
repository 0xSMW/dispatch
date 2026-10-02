import { Command, Option } from "@commander-js/extra-typings";
import { runCreate } from "../../lib/actions.js";
import { helpText } from "../../lib/help.js";
import { collect, compact, jsonFlag, many } from "../../lib/json.js";
import { promptMissing } from "../../lib/prompts.js";

export const create = new Command("create")
  .description("Create a contact")
  .argument("[email]", "Email address")
  .option("--email <email>", "Email address (same as the positional argument)")
  .option("--first-name <name>", "First name")
  .option("--last-name <name>", "Last name")
  .addOption(new Option("--first <name>", "Old name for --first-name").hideHelp())
  .addOption(new Option("--last <name>", "Old name for --last-name").hideHelp())
  .option("--unsubscribed", "Create the contact as unsubscribed from everything")
  .option("--properties <json>", "Custom properties as JSON")
  .option("--segment-id <id>", "Add to this segment. Repeatable", collect)
  .addHelpText(
    "after",
    helpText({
      output: '{"object":"contact","id":"..."}',
      codes: ["missing_flags", "invalid_json", "create_error", "validation_error"],
      examples: [
        "dispatch contacts create ada@example.com --first-name Ada --last-name Lovelace",
        "dispatch contacts create --email ada@example.com --segment-id seg_123",
      ],
    }),
  )
  .action(async (email, options, command) => {
    await runCreate(command, {
      prepare: (globals) => promptMissing({ email: email ?? options.email }, [{ key: "email", flag: "--email", label: "Email" }], globals),
      call: (api, input) =>
        api.contacts.create({
          email: input.email,
          ...compact({
            firstName: options.firstName ?? options.first,
            lastName: options.lastName ?? options.last,
            unsubscribed: options.unsubscribed,
            properties: jsonFlag<Record<string, unknown>>(options.properties, "--properties"),
            segments: many(options.segmentId)?.map((id) => ({ id })),
          }),
        }),
      done: (contact: { id: string }) => `Created contact ${contact.id}`,
    });
  });
