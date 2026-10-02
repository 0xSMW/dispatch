import { Command, Option } from "@commander-js/extra-typings";
import { runGet } from "../../../lib/actions.js";
import { helpText } from "../../../lib/help.js";
import { compact } from "../../../lib/json.js";
import { pickReceived } from "../../../lib/pickers.js";

export const get = new Command("get")
  .description("Show one received email")
  .argument("[id]", "Received email ID")
  .addOption(new Option("--html-format <format>", "How inline images appear in html").choices(["data_uri", "cid"] as const))
  .addHelpText(
    "after",
    helpText({
      output: '{"object":"email","id":"...","from":"...","to":["..."],"subject":"...","html":"...","text":"..."}',
      codes: ["missing_id", "fetch_error", "not_found"],
      examples: ["dispatch emails receiving get rcv_123"],
    }),
  )
  .action(async (id, options, command) => {
    await runGet(command, {
      prepare: (globals) => pickReceived(id, globals),
      call: (api, target) => api.emails.receiving.get(target, compact({ htmlFormat: options.htmlFormat })),
    });
  });
