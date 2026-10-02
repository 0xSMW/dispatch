import { Command } from "@commander-js/extra-typings";
import { runWrite } from "../../lib/actions.js";
import { contactRef } from "../../lib/commands.js";
import { CliError } from "../../lib/errors.js";
import { helpText } from "../../lib/help.js";
import { csv, jsonFlag } from "../../lib/json.js";
import { pickContact } from "../../lib/pickers.js";
import { promptMissing } from "../../lib/prompts.js";

type Subscription = { id: string; subscription: "opt_in" | "opt_out" };

// JSON like [{"id":"t1","subscription":"opt_in"}], or the short form t1=opt_in,t2=opt_out.
export function parseTopics(value: string): Subscription[] {
  if (value.trim().startsWith("[")) {
    const parsed = jsonFlag<Subscription[]>(value, "--topics");
    if (!Array.isArray(parsed)) throw new CliError("invalid_json", "--topics must be a JSON array");
    return parsed;
  }
  return (csv(value) ?? []).map((pair) => {
    const [id, subscription = "opt_in"] = pair.split("=");
    if (!id || (subscription !== "opt_in" && subscription !== "opt_out")) {
      throw new CliError("invalid_flag", `--topics expects topic_id=opt_in or topic_id=opt_out, got "${pair}"`);
    }
    return { id, subscription };
  });
}

export const updateTopics = new Command("update-topics")
  .description("Opt a contact in or out of topics")
  .argument("[id]", "Contact ID or email")
  .option("--topics <topics>", 'JSON array, or "topic_id=opt_in,topic_id=opt_out"')
  .addHelpText(
    "after",
    helpText({
      output: '{"id":"..."}',
      codes: ["missing_id", "missing_flags", "invalid_flag", "update_error"],
      examples: ["dispatch contacts update-topics ada@example.com --topics top_123=opt_out"],
    }),
  )
  .action(async (id, options, command) => {
    await runWrite(command, {
      prepare: async (globals) => {
        const contact = await pickContact(id, globals);
        const asked = await promptMissing(
          { topics: options.topics },
          [{ key: "topics", flag: "--topics", label: "Topics (topic_id=opt_in,...)" }],
          globals,
        );
        return { contact, topics: parseTopics(asked.topics) };
      },
      call: (api, input) => api.contacts.topics.update({ ...contactRef(input.contact), topics: input.topics }),
      done: () => "Updated topic subscriptions",
    });
  });
