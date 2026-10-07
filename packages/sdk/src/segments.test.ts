import { afterEach, expect, it, vi } from "vitest";
import { Dispatch, type Rule } from "./index.js";

afterEach(() => vi.unstubAllGlobals());
it("preserves nested snake-case engagement and omitted versus null PATCH rules", async () => {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  vi.stubGlobal("fetch", async (url: string, input: RequestInit) => {
    calls.push({ url, method: input.method!, body: JSON.parse(String(input.body)) });
    return new Response(JSON.stringify({ count: 0, sample: [] }), { headers: { "content-type": "application/json" } });
  });
  const client = new Dispatch({ apiKey: "synthetic-segment-key" });
  const rule: Rule = { type: "rule", field: "email.opened", operator: "eq", value: false, scope: { automation_id: "auto_1" }, window: "30 days" };
  await client.segments.create({ name: "Filter", rule });
  await client.segments.update("s/1", { name: "Renamed" });
  await client.segments.update("s/1", { rule: null });
  await client.segments.preview(rule);
  expect(calls.map((call) => call.body)).toEqual([{ name: "Filter", rule }, { name: "Renamed" }, { rule: null }, { rule }]);
  expect(calls[2]!.url).toContain("/segments/s%2F1");
  expect(calls[3]!.url).toContain("/segments/preview");
});
