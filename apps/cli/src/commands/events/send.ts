import { Command } from "@commander-js/extra-typings";
import { runWrite } from "../../lib/actions.js";
import { CliError } from "../../lib/errors.js";
import { helpText } from "../../lib/help.js";
import { jsonFlag } from "../../lib/json.js";
import { promptMissing } from "../../lib/prompts.js";

export const send = new Command("send")
  .description("Fire an event for a contact, which starts matching automations")
  .option("--event <name>", "Event name, such as user.created")
  .option("--email <email>", "The contact's email")
  .option("--contact-id <id>", "The contact's ID")
  .option("--payload <json>", "Event data as JSON")
  .addHelpText(
    "after",
    helpText({
      output: '{"object":"event","id":"..."}',
      codes: ["missing_flags", "invalid_flags", "invalid_json", "send_error"],
      examples: ['dispatch events send --event user.created --email ada@example.com --payload \'{"plan":"pro"}\''],
    }),
  )
  .action(async (options, command) => {
    await runWrite(command, {
      code: "send_error",
      loading: "Sending...",
      prepare: async (globals) => {
        if (options.email && options.contactId) throw new CliError("invalid_flags", "Use --email or --contact-id, not both");
        const { event } = await promptMissing({ event: options.event }, [{ key: "event", flag: "--event", label: "Event name" }], globals);
        const contact = options.contactId
          ? { contactId: options.contactId }
          : {
              email: (
                await promptMissing(
                  { email: options.email },
                  [{ key: "email", flag: "--email or --contact-id", label: "Contact email" }],
                  globals,
                )
              ).email,
            };
        return { event, ...contact, payload: jsonFlag<Record<string, unknown>>(options.payload, "--payload") ?? {} };
      },
      call: (api, input) => api.events.send(input),
      done: (event: { id?: string }) => `Sent event${event?.id ? ` ${event.id}` : ""}`,
    });
  });
