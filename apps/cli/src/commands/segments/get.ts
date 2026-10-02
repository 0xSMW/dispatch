import { getCommand } from "../../lib/commands.js";
import { pickSegment } from "../../lib/pickers.js";

export const get = getCommand({
  noun: "segment",
  pick: pickSegment,
  call: (api, id) => api.segments.get(id),
  example: "dispatch segments get seg_123",
});
