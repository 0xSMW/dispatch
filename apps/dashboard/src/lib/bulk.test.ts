import { describe, expect, it, vi } from "vitest";
import { each } from "./bulk";
import { ApiError } from "./client";

describe("each", () => {
  it("runs one request at a time and treats a 404 on a delete as done", async () => {
    let active = 0;
    let most = 0;
    const run = vi.fn(async (id: string) => {
      active += 1;
      most = Math.max(most, active);
      await Promise.resolve();
      active -= 1;
      if (id === "gone") throw new ApiError("not_found", 404, "Contact not found");
      if (id === "bad") throw new ApiError("application_error", 500, "Broken");
    });
    const failed = await each(["a", "gone", "bad", "b"], run, { gone: true });
    expect(most).toBe(1);
    expect(run).toHaveBeenCalledTimes(4);
    expect(failed).toHaveLength(1);
    expect((failed[0] as Error).message).toBe("Broken");
    expect(await each(["gone"], run)).toHaveLength(1);
  });

  it("waits and tries the same item again after a 429", async () => {
    const calls: string[] = [];
    let limited = 2;
    const run = async (id: string) => {
      calls.push(id);
      if (id === "a" && limited-- > 0) throw new ApiError("rate_limit_exceeded", 429, "Rate limit exceeded");
    };
    expect(await each(["a", "b"], run, { pause: 0 })).toEqual([]);
    expect(calls).toEqual(["a", "a", "a", "b"]);
  });
});
