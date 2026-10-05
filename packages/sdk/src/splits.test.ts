// Authored SDK wire fixtures; execution deferred to the milestone8 SDK gate.
import { afterEach, expect, it, vi } from "vitest";
import { Dispatch } from "./index.js";

afterEach(() => vi.unstubAllGlobals());
it("maps split metric dates, escaped permanent keys and guarded winner/resume requests", async () => {
  const fetch = vi.fn().mockImplementation(async () => Response.json({ id: "a", status: "paused", version: 1 }));
  vi.stubGlobal("fetch", fetch);
  const dispatch = new Dispatch({ apiKey: "synthetic", baseUrl: "https://dispatch.example.test" });
  await dispatch.automations.splitMetrics("a/1", "s/1", { startDate: "2026-09-01", endDate: "2026-09-02" });
  expect(fetch.mock.calls[0]?.[0]).toBe("https://dispatch.example.test/automations/a%2F1/steps/s%2F1/metrics?start_date=2026-09-01&end_date=2026-09-02");
  await dispatch.automations.pickWinner("a/1", "s/1", { variant: "b", version: 0 });
  expect(fetch.mock.calls[1]?.[0]).toBe("https://dispatch.example.test/automations/a%2F1/steps/s%2F1/winner");
  expect(JSON.parse(fetch.mock.calls[1]?.[1].body)).toEqual({ variant: "b", version: 0 });
  await dispatch.automations.update("a/1", { status: "enabled", expectedVersion: 1 });
  expect(JSON.parse(fetch.mock.calls[2]?.[1].body)).toEqual({ status: "enabled", expected_version: 1 });
});
