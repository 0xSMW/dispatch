import { getCommand } from "../../lib/commands.js";
import { pickTopic } from "../../lib/pickers.js";

export const get = getCommand({
  noun: "topic",
  pick: pickTopic,
  call: (api, id) => api.topics.get(id),
  example: "dispatch topics get top_123",
});
