import { Command } from "@commander-js/extra-typings";
import { helpText } from "../../lib/help.js";
import { attachment } from "./attachment.js";
import { attachments } from "./attachments.js";
import { batch } from "./batch.js";
import { cancel } from "./cancel.js";
import { events } from "./events.js";
import { get } from "./get.js";
import { list } from "./list.js";
import { metrics } from "./metrics.js";
import { receiving } from "./receiving/index.js";
import { retry } from "./retry.js";
import { send } from "./send.js";
import { share } from "./share.js";
import { update } from "./update.js";

export const emails = new Command("emails")
  .description("Send and inspect emails")
  .addHelpText("after", helpText({ examples: ["dispatch emails", "dispatch emails send --to you@example.com"] }))
  .addCommand(list, { isDefault: true })
  .addCommand(send)
  .addCommand(get)
  .addCommand(batch)
  .addCommand(cancel)
  .addCommand(update)
  .addCommand(share)
  .addCommand(metrics)
  .addCommand(attachments)
  .addCommand(attachment)
  .addCommand(retry)
  .addCommand(events)
  .addCommand(receiving);
