import { broadcastAction } from "./action.js";

export const resume = broadcastAction("resume", "Resume a paused broadcast (Dispatch only)", "Resumed", (api, id) =>
  api.broadcasts.resume(id),
);
