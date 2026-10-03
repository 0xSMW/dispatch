import { describe, expect, it, vi } from "vitest";
import { emitRunEvent, type RunEventType } from "./run-events.js";

describe("automation run events", () => {
  it.each<RunEventType>(["automation.run.started", "automation.run.completed", "automation.run.failed"])("fans out %s once with stable run attribution", async (type) => {
    const seen = new Set<string>();
    const query = vi.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.includes("from automation_runs")) return { rows: [{
        id: "run_1", automation_id: "automation_1", request_id: "req_1", contact_id: "contact_1",
        state: type.endsWith("started") ? "ready" : type.endsWith("failed") ? "failed" : "done",
      }] };
      if (sql.includes("insert into email_events")) {
        const key = String(params[6]);
        if (seen.has(key)) return { rows: [] };
        seen.add(key);
        return { rows: [{ id: "event_1", tenant_id: params[1], request_id: params[2], type: params[5] }] };
      }
      return { rows: [] };
    });
    await emitRunEvent({ query }, "tenant_1", "run_1", type);
    await emitRunEvent({ query }, "tenant_1", "run_1", type);
    const writes = query.mock.calls.filter(([sql]) => sql.includes("insert into email_events"));
    expect(writes[0]![1]![6]).toBe(`run_1:${type}`);
    expect(JSON.parse(String(writes[0]![1]![7]))).toMatchObject({ automation_id: "automation_1", run_id: "run_1", contact_id: "contact_1" });
    const attempts = query.mock.calls.filter(([sql]) => sql.includes("insert into webhook_attempts"));
    expect(attempts).toHaveLength(1);
    expect(attempts[0]![1]).toEqual(["tenant_1", type, "req_1", "event_1"]);
  });
});
