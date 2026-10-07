import type { Client } from "../../lib/client";
import type { Automation } from "../../types";

/** No Stop or compensating resume: a failed edit stays paused for review. */
export async function pickWinner(client: Client, row: Automation, stepKey: string, variant: string, onSaved: (row: Automation) => void) {
  if (row.status !== "enabled" && row.status !== "paused") throw new Error("Enable the automation before picking a winner.");
  const path = `/automations/${encodeURIComponent(row.id)}`;
  const paused = row.status === "paused" ? row : await client.patch<Automation>(path, { status: "paused", expected_version: row.version });
  onSaved(paused);
  const edited = await client.post<Automation>(`${path}/steps/${encodeURIComponent(stepKey)}/winner`, { variant, version: paused.version });
  onSaved(edited);
  const resumed = await client.patch<Automation>(path, { status: "enabled", expected_version: edited.version });
  onSaved(resumed);
  return resumed;
}
