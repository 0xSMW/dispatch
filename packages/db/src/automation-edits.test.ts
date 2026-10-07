import { describe, expect, it } from "vitest";
import { strandedRuns, usedKeys } from "./automation-edits.js";
import type { Step } from "@dispatchmail/core";

const before: Step[] = [
  { key: "start", type: "trigger", config: { event_name: "start" } },
  { key: "wait", type: "delay", config: { duration: "1 day" } },
  { key: "send", type: "send_email", config: {} },
];
describe("paused graph planning", () => {
  it("counts only removed or type-changed positions, not configuration changes", () => {
    const after: Step[] = [before[0]!, { ...before[1]!, config: { duration: "2 days" } }, { ...before[2]!, type: "contact_delete" }];
    expect(strandedRuns([
      { id: "kept", key: "wait" }, { id: "changed", key: "send" },
      { id: "gone", key: "removed" }, { id: "gone2", key: "removed" },
    ], before, after)).toEqual({ ids: ["changed", "gone", "gone2"], preview: { stranded_runs: 3, by_step: { send: 1, removed: 2 } } });
  });
  it("retains removed reservations and rejects reuse with another type", () => {
    const history = usedKeys(before);
    expect(usedKeys([before[0]!], history)).toEqual(history);
    expect(() => usedKeys([{ ...before[1]!, type: "contact_delete" }], history)).toThrow("Step key wait was already used for delay");
    expect(usedKeys([{ ...before[1]!, key: "new", type: "contact_delete" }], history)).toMatchObject({ wait: "delay", new: "contact_delete" });
  });
  it("handles prototype-like keys as ordinary own keys and counts", () => {
    const steps: Step[] = [{ key: "__proto__", type: "delay", config: {} }];
    expect(JSON.stringify(usedKeys(steps))).toBe('{"__proto__":"delay"}');
    expect(JSON.stringify(strandedRuns([{ id: "one", key: "__proto__" }], steps, []).preview))
      .toBe('{"stranded_runs":1,"by_step":{"__proto__":1}}');
  });
});
