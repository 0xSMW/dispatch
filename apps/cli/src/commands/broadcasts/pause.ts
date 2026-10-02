import { broadcastAction } from "./action.js";

export const pause = broadcastAction("pause", "Pause a sending broadcast (Dispatch only)", "Paused", (api, id) => api.broadcasts.pause(id));
