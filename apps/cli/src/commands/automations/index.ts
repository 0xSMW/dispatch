import { Command } from "@commander-js/extra-typings";
import { helpText } from "../../lib/help.js";
import { create } from "./create.js";
import { enroll } from "./enroll.js";
import { enrollJobs } from "./enroll-jobs/index.js";
import { remove } from "./delete.js";
import { duplicate } from "./duplicate.js";
import { get } from "./get.js";
import { list } from "./list.js";
import { open } from "./open.js";
import { runs } from "./runs/index.js";
import { stop } from "./stop.js";
import { update } from "./update.js";

export const automations = new Command("automations")
  .description("Manage event and contact automations, enrollments, and runs")
  .addHelpText("after", helpText({ examples: ["dispatch automations", "dispatch automations runs auto_123"] }))
  .addCommand(list, { isDefault: true })
  .addCommand(create)
  .addCommand(get)
  .addCommand(update)
  .addCommand(remove)
  .addCommand(duplicate)
  .addCommand(stop)
  .addCommand(enroll)
  .addCommand(enrollJobs)
  .addCommand(open)
  .addCommand(runs);
