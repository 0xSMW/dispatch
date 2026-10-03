import { describe, expect, it } from "vitest";
import { countsByStep, emailRows, zeroEmails } from "./EmailMetrics";
import type { Tree } from "./graph";

describe("automation email metrics", () => {
  it("names templates, includes zero-send steps, and keeps legacy and removed-step counts", () => {
    const tree: Tree = { trigger: "start", event: "joined", steps: [
      { key: "welcome", type: "send_email", config: { template: { id: "welcome" } } },
      { key: "receipt", type: "send_email", config: { template: "tpl_receipt" } },
    ] };
    const report = { data: [
      { ...zeroEmails, automation_id: "automation_1", automation_step: "welcome", sent: 4, opened: 2 },
      { ...zeroEmails, automation_id: "automation_1", automation_step: null, sent: 3 },
      { ...zeroEmails, automation_id: "automation_1", automation_step: "removed", sent: 1 },
    ] };
    expect(countsByStep(report).welcome?.sent).toBe(4);
    expect(countsByStep(report)).not.toHaveProperty("null");
    const rows = emailRows(tree, { welcome: "Welcome", tpl_receipt: "Receipt" }, report);
    expect(rows.map((row) => [row.key, row.name, row.sent])).toEqual([
      ["welcome", "Welcome", 4], ["receipt", "Receipt", 0],
      ["legacy", "Earlier emails (step unknown)", 3], ["removed", "Step removed", 1],
    ]);
  });
});
