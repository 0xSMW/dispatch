import { Command } from "@commander-js/extra-typings";
import { helpText } from "../../lib/help.js";
import { add } from "./add.js";
import { create } from "./create.js";
import { remove } from "./delete.js";
import { duplicate } from "./duplicate.js";
import { eject } from "./eject.js";
import { get } from "./get.js";
import { library } from "./library.js";
import { list } from "./list.js";
import { open } from "./open.js";
import { publish } from "./publish.js";
import { push } from "./push.js";
import { render } from "./render.js";
import { update } from "./update.js";

export const templates = new Command("templates")
  .description("Manage templates, push React Email files, and use the default library")
  .addHelpText(
    "after",
    helpText({ examples: ["dispatch templates", "dispatch templates push emails --publish", "dispatch templates library"] }),
  )
  .addCommand(list, { isDefault: true })
  .addCommand(create)
  .addCommand(get)
  .addCommand(update)
  .addCommand(publish)
  .addCommand(duplicate)
  .addCommand(remove)
  .addCommand(open)
  .addCommand(render)
  .addCommand(push)
  .addCommand(library)
  .addCommand(add)
  .addCommand(eject);
