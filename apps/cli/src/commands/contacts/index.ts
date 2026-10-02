import { Command } from "@commander-js/extra-typings";
import { helpText } from "../../lib/help.js";
import { activity } from "./activity.js";
import { addSegment } from "./add-segment.js";
import { create } from "./create.js";
import { remove } from "./delete.js";
import { get } from "./get.js";
import { imports } from "./imports/index.js";
import { list } from "./list.js";
import { removeSegment } from "./remove-segment.js";
import { segments } from "./segments.js";
import { topics } from "./topics.js";
import { update } from "./update.js";
import { updateTopics } from "./update-topics.js";

export const contacts = new Command("contacts")
  .description("Manage contacts, their segments, and their topic subscriptions")
  .addHelpText("after", helpText({ examples: ["dispatch contacts", "dispatch contacts create ada@example.com"] }))
  .addCommand(list, { isDefault: true })
  .addCommand(create)
  .addCommand(get)
  .addCommand(update)
  .addCommand(remove)
  .addCommand(segments)
  .addCommand(addSegment)
  .addCommand(removeSegment)
  .addCommand(topics)
  .addCommand(updateTopics)
  .addCommand(activity)
  .addCommand(imports);
