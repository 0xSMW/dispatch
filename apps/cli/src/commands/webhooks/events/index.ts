import { Command } from "@commander-js/extra-typings";
import { helpText } from "../../../lib/help.js";
import { attempts } from "./attempts.js";
import { get } from "./get.js";
import { list } from "./list.js";
import { replay } from "./replay.js";

export const events = new Command("events")
  .description("Inspect and replay events sent to a webhook")
  .addHelpText("after", helpText({ examples: ["dispatch webhooks events wh_123", "dispatch webhooks events replay wh_123"] }))
  .addCommand(list, { isDefault: true })
  .addCommand(get)
  .addCommand(attempts)
  .addCommand(replay);
