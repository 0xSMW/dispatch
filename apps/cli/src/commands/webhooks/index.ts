import { Command } from "@commander-js/extra-typings";
import { helpText } from "../../lib/help.js";
import { create } from "./create.js";
import { remove } from "./delete.js";
import { events } from "./events/index.js";
import { get } from "./get.js";
import { list } from "./list.js";
import { listenCommand } from "./listen.js";
import { rotate } from "./rotate-signing-secret.js";
import { test } from "./test.js";
import { update } from "./update.js";

export const webhooks = new Command("webhooks")
  .description("Manage webhooks and receive events locally")
  .addHelpText("after", helpText({ examples: ["dispatch webhooks", "dispatch webhooks listen --forward-to http://localhost:3000/hooks"] }))
  .addCommand(list, { isDefault: true })
  .addCommand(create)
  .addCommand(get)
  .addCommand(update)
  .addCommand(remove)
  .addCommand(rotate)
  .addCommand(listenCommand)
  .addCommand(events)
  .addCommand(test);
