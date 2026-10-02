import { Command } from "@commander-js/extra-typings";
import type { Result } from "@dispatchmail/sdk";
import { runWrite } from "../../lib/actions.js";
import type { Api } from "../../lib/client.js";
import { helpText } from "../../lib/help.js";
import { pickBroadcast } from "../../lib/pickers.js";

// A one-step broadcast command such as cancel, pause, or resume.
export function broadcastAction(name: string, description: string, past: string, call: (api: Api, id: string) => Promise<Result<any>>) {
  return new Command(name)
    .description(description)
    .argument("[id]", "Broadcast ID")
    .addHelpText(
      "after",
      helpText({
        output: '{"object":"broadcast","id":"..."}',
        codes: ["missing_id", `${name}_error`],
        examples: [`dispatch broadcasts ${name} bc_123`],
      }),
    )
    .action(async (id, _options, command) => {
      await runWrite(command, {
        code: `${name}_error`,
        prepare: (globals) => pickBroadcast(id, globals),
        call,
        done: (data: { id?: string } | null) => `${past} broadcast ${data?.id ?? id ?? ""}`.trim(),
      });
    });
}
