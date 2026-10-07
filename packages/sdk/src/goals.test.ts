// Authored for milestone 8 SDK contract validation, not run during engineering.
import { afterEach, expect, it, vi } from "vitest";
import { Dispatch } from "./index.js";
afterEach(() => vi.unstubAllGlobals());
it("maps goal query/body keys without changing shared rules and updates library explicitly", async () => {
  const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", fetch);
  const dispatch = new Dispatch({ apiKey: "synthetic-key", baseUrl: "http://localhost:3100" });
  const target = { rule: { type: "rule" as const, field: "contact.paid", operator: "eq" as const, value: true } };
  await dispatch.goals.create({ name: "Paid", target, windowDays: 7 });
  expect(JSON.parse(String(fetch.mock.calls[0]![1]!.body))).toEqual({ name: "Paid", target, window_days: 7 });
  await dispatch.goals.metrics("goal_1", { automationId: "a", stepKey: "send", startDate: "2026-09-01T00:00:00Z" });
  expect(String(fetch.mock.calls[1]![0])).toContain("/goals/goal_1/metrics?automation_id=a&step_key=send&start_date=");
  await dispatch.goals.update("goal_1", { eligibility: null });
  expect(JSON.parse(String(fetch.mock.calls[2]![1]!.body))).toEqual({ eligibility: null });
  await dispatch.brand.updateLibrary();
  expect(String(fetch.mock.calls[3]![0])).toContain("/brand/update-library");
});
