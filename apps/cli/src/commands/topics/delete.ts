import { deleteCommand } from "../../lib/commands.js";
import { pickTopic } from "../../lib/pickers.js";

export const remove = deleteCommand({
  noun: "topic",
  pick: pickTopic,
  call: (api, id) => api.topics.remove(id),
  example: "dispatch topics delete top_123 --yes",
});
