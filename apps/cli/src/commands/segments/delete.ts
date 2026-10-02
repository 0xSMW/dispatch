import { deleteCommand } from "../../lib/commands.js";
import { pickSegment } from "../../lib/pickers.js";

export const remove = deleteCommand({
  noun: "segment",
  pick: pickSegment,
  call: (api, id) => api.segments.remove(id),
  example: "dispatch segments delete seg_123 --yes",
});
