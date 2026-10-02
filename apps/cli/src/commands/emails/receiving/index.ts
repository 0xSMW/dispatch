import { Command } from "@commander-js/extra-typings";
import { helpText } from "../../../lib/help.js";
import { attachment } from "./attachment.js";
import { attachments } from "./attachments.js";
import { forward } from "./forward.js";
import { get } from "./get.js";
import { list } from "./list.js";
import { listen } from "./listen.js";
import { simulate } from "./simulate.js";

export const receiving = new Command("receiving")
  .description("Read, forward, and watch received emails")
  .addHelpText("after", helpText({ examples: ["dispatch emails receiving", "dispatch emails receiving listen"] }))
  .addCommand(list, { isDefault: true })
  .addCommand(get)
  .addCommand(attachments)
  .addCommand(attachment)
  .addCommand(forward)
  .addCommand(listen)
  .addCommand(simulate);
