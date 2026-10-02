import { Command } from "@commander-js/extra-typings";
import { helpText } from "../../lib/help.js";
import { cancel } from "./cancel.js";
import { clickedLinks } from "./clicked-links.js";
import { create } from "./create.js";
import { remove } from "./delete.js";
import { duplicate } from "./duplicate.js";
import { get } from "./get.js";
import { list } from "./list.js";
import { open } from "./open.js";
import { pause } from "./pause.js";
import { recipients } from "./recipients.js";
import { resume } from "./resume.js";
import { send } from "./send.js";
import { update } from "./update.js";

export const broadcasts = new Command("broadcasts")
  .description("Create and send broadcasts to segments")
  .addHelpText(
    "after",
    helpText({ examples: ["dispatch broadcasts", "dispatch broadcasts create --from news@acme.com --segment-id seg_123"] }),
  )
  .addCommand(list, { isDefault: true })
  .addCommand(create)
  .addCommand(get)
  .addCommand(update)
  .addCommand(send)
  .addCommand(cancel)
  .addCommand(duplicate)
  .addCommand(remove)
  .addCommand(open)
  .addCommand(clickedLinks)
  .addCommand(recipients)
  .addCommand(pause)
  .addCommand(resume);
