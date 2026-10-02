import { beforeEach, describe, expect, it, vi } from "vitest";
import { step, type TailState } from "../../src/commands/tail.js";
import { requireClient } from "../../src/lib/client.js";
import { list, method, ok, setNonInteractive, spies } from "../helpers.js";

vi.mock("@dispatchmail/sdk", async () => (await import("../helpers.js")).sdk);

describe("tail", () => {
  beforeEach(() => setNonInteractive());

  it("makes one list call per poll, and reports new emails and status changes from it", async () => {
    const { stdout } = spies();
    const api = requireClient({});
    const state: TailState = { watching: new Map<string, string>() };

    method("emails.list").mockResolvedValueOnce(
      list([
        { id: "e2", last_event: "sent" },
        { id: "e1", last_event: "delivered" },
      ]),
    );
    await step(api, state, {});
    expect(method("emails.list")).toHaveBeenLastCalledWith({ limit: 100 });
    expect(state.newest).toBe("e2");

    // e3 is new, e2 changed, and e0 committed late behind e2: all three are on the one page.
    method("emails.list").mockResolvedValueOnce(
      list([
        { id: "e3", last_event: "queued" },
        { id: "e2", last_event: "delivered" },
        { id: "e0", last_event: "sent" },
        { id: "e1", last_event: "delivered" },
      ]),
    );
    await step(api, state, {});
    expect(method("emails.list")).toHaveBeenCalledTimes(2);
    expect(method("emails.get")).not.toHaveBeenCalled();
    expect(state.newest).toBe("e3");

    const lines = stdout()
      .split("\n")
      .map((line) => JSON.parse(line) as { id: string; last_event: string });
    expect(lines.map((line) => `${line.id}:${line.last_event}`)).toEqual(["e1:delivered", "e2:sent", "e0:sent", "e3:queued", "e2:delivered"]);
    expect([...state.watching.keys()].sort()).toEqual(["e0", "e3"]);
  });

  it("looks up at most three watched emails that have left the newest page", async () => {
    spies();
    const api = requireClient({});
    const watching = new Map(Array.from({ length: 8 }, (_, index) => [`old${index}`, "sent"] as [string, string]));
    const state: TailState = { watching, seen: new Set(["n1"]), newest: "n1" };
    method("emails.list").mockResolvedValueOnce(list([{ id: "n1", last_event: "delivered" }]));
    method("emails.get").mockImplementation(async (id: string) => ok({ id, last_event: "sent" }));
    await step(api, state, {});
    expect(method("emails.get")).toHaveBeenCalledTimes(3);
    expect(method("emails.get").mock.calls.map((call) => call[0])).toEqual(["old0", "old1", "old2"]);
    // The three that were checked go to the back, so the next poll checks the next three.
    expect([...state.watching.keys()].slice(0, 3)).toEqual(["old3", "old4", "old5"]);
  });
});
