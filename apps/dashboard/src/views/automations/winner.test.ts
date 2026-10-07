import { expect, it, vi } from "vitest";
import type { Client } from "../../lib/client";
import type { Automation } from "../../types";
import { pickWinner } from "./winner";

const row = { id: "a/1", status: "enabled", version: 0 } as Automation;
it("pauses, edits only the expected split version and resumes the updated version", async () => {
  const paused = { ...row, status: "paused" } as Automation;
  const edited = { ...paused, version: 1 };
  const resumed = { ...edited, status: "enabled" } as Automation;
  const client = { patch: vi.fn().mockResolvedValueOnce(paused).mockResolvedValueOnce(resumed), post: vi.fn().mockResolvedValue(edited) } as unknown as Client;
  const saved = vi.fn();
  expect(await pickWinner(client, row, "split/1", "b", saved)).toEqual(resumed);
  expect(client.patch).toHaveBeenNthCalledWith(1, "/automations/a%2F1", { status: "paused", expected_version: 0 });
  expect(client.post).toHaveBeenCalledWith("/automations/a%2F1/steps/split%2F1/winner", { variant: "b", version: 0 });
  expect(client.patch).toHaveBeenNthCalledWith(2, "/automations/a%2F1", { status: "enabled", expected_version: 1 });
  expect(saved.mock.calls.map(([value]) => value.status)).toEqual(["paused", "paused", "enabled"]);
});
it("does not resume or Stop after a failed winner edit", async () => {
  const paused = { ...row, status: "paused" } as Automation;
  const client = { patch: vi.fn().mockResolvedValue(paused), post: vi.fn().mockRejectedValue(new Error("stale version")) } as unknown as Client;
  const saved = vi.fn();
  await expect(pickWinner(client, row, "split", "b", saved)).rejects.toThrow("stale version");
  expect(client.patch).toHaveBeenCalledTimes(1);
  expect(saved).toHaveBeenCalledWith(paused);
});
it("keeps a successfully edited version paused if resume fails", async () => {
  const paused = { ...row, status: "paused" } as Automation;
  const edited = { ...paused, version: 1 };
  const client = { patch: vi.fn().mockRejectedValue(new Error("resume refused")), post: vi.fn().mockResolvedValue(edited) } as unknown as Client;
  const saved = vi.fn();
  await expect(pickWinner(client, paused, "split", "b", saved)).rejects.toThrow("resume refused");
  expect(saved).toHaveBeenLastCalledWith(edited);
  expect(client.patch).toHaveBeenCalledTimes(1);
});
