import { broadcastAction } from "./action.js";

export const cancel = broadcastAction("cancel", "Cancel a scheduled or sending broadcast", "Canceled", (api, id) =>
  api.broadcasts.cancel(id),
);
