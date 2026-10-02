import { deleteCommand } from "../../lib/commands.js";
import { pickEvent } from "../../lib/pickers.js";

export const remove = deleteCommand({
  noun: "event",
  arg: "Event ID or name",
  pick: pickEvent,
  call: (api, id) => api.events.remove(id),
  example: "dispatch events delete user.created --yes",
});
