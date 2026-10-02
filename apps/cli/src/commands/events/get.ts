import { getCommand } from "../../lib/commands.js";
import { pickEvent } from "../../lib/pickers.js";

export const get = getCommand({
  noun: "event",
  arg: "Event ID or name",
  pick: pickEvent,
  call: (api, id) => api.events.get(id),
  example: "dispatch events get user.created",
});
