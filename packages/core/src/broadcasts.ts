// API statuses and the stored states they represent, shared by presenters and filters.
export const broadcastStates: Record<string, readonly string[]> = {
  draft: ["draft"],
  scheduled: ["scheduled"],
  queued: ["sending", "paused"],
  sent: ["sent"],
  canceled: ["cancelled"],
};

export function broadcastStatus(status: string): string {
  return Object.entries(broadcastStates).find(([, states]) => states.includes(status))?.[0] ?? status;
}
