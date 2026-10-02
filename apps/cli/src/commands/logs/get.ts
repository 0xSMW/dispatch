import { getCommand } from "../../lib/commands.js";
import { pickLog } from "../../lib/pickers.js";

export const get = getCommand({
  noun: "log",
  pick: pickLog,
  call: (api, id) => api.logs.get(id),
  example: "dispatch logs get log_123",
  output:
    '{"object":"log","id":"...","method":"POST","endpoint":"/emails","response_status":422,"request_body":{...},"response_body":{...}}',
});
