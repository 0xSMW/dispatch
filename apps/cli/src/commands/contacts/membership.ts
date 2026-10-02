import { Command } from "@commander-js/extra-typings";
import type { Result } from "@dispatchmail/sdk";
import { runWrite } from "../../lib/actions.js";
import type { Api } from "../../lib/client.js";
import { contactRef } from "../../lib/commands.js";
import { helpText } from "../../lib/help.js";
import { pickContact, pickSegment } from "../../lib/pickers.js";

type Ref = { id: string } | { email: string };

// add-segment and remove-segment differ only in the call and the wording.
export function membership(
  name: string,
  description: string,
  past: string,
  call: (api: Api, input: Ref & { segmentId: string }) => Promise<Result<any>>,
) {
  return new Command(name)
    .description(description)
    .argument("[id]", "Contact ID or email")
    .option("--segment-id <id>", "Segment ID")
    .addHelpText(
      "after",
      helpText({
        output: '{"id":"..."}',
        codes: ["missing_id", "update_error"],
        examples: [`dispatch contacts ${name} ada@example.com --segment-id seg_123`],
      }),
    )
    .action(async (id, options, command) => {
      await runWrite(command, {
        prepare: async (globals) => ({ contact: await pickContact(id, globals), segmentId: await pickSegment(options.segmentId, globals) }),
        call: (api, input) => call(api, { ...contactRef(input.contact), segmentId: input.segmentId }),
        done: () => past,
      });
    });
}
