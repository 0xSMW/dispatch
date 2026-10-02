import { beforeEach, describe, expect, it, vi } from "vitest";
import { events } from "../../../src/commands/events/index.js";
import { captureExit, errorJson, list, method, run, setNonInteractive, spies } from "../../helpers.js";

vi.mock("@dispatchmail/sdk", async () => (await import("../../helpers.js")).sdk);

describe("events", () => {
  beforeEach(() => {
    setNonInteractive();
    captureExit();
  });

  it("lists definitions by default and fired events under history", async () => {
    method("events.list").mockResolvedValue(list([]));
    method("events.fired.list").mockResolvedValue(list([]));
    spies();
    await run(events, []);
    expect(method("events.list")).toHaveBeenCalledWith({ limit: 10 });
    await run(events, ["history", "--limit", "5"]);
    expect(method("events.fired.list")).toHaveBeenCalledWith({ limit: 5 });
    await run(events, ["history", "evt_1"]);
    expect(method("events.fired.get")).toHaveBeenCalledWith("evt_1");
  });

  it("send fires for an email or a contact ID, never both", async () => {
    spies();
    await run(events, ["send", "--event", "user.created", "--email", "ada@example.com", "--payload", '{"plan":"pro"}']);
    expect(method("events.send")).toHaveBeenCalledWith({ event: "user.created", email: "ada@example.com", payload: { plan: "pro" } });
    await run(events, ["send", "--event", "user.created", "--contact-id", "ct_1"]);
    expect(method("events.send")).toHaveBeenLastCalledWith({ event: "user.created", contactId: "ct_1", payload: {} });
    const { stderr } = spies();
    expect(await run(events, ["send", "--event", "x", "--email", "a@x.com", "--contact-id", "ct_1"])).toBe(1);
    expect(errorJson(stderr()).error.code).toBe("invalid_flags");
  });

  it("create, get, update, and delete act on definitions", async () => {
    spies();
    await run(events, ["create", "user.created", "--schema", '{"plan":"string"}']);
    expect(method("events.create")).toHaveBeenCalledWith({ name: "user.created", schema: { plan: "string" } });
    await run(events, ["get", "user.created"]);
    expect(method("events.get")).toHaveBeenCalledWith("user.created");
    await run(events, ["update", "user.created", "--schema", '{"seats":"number"}']);
    expect(method("events.update")).toHaveBeenCalledWith("user.created", { schema: { seats: "number" } });
    expect(await run(events, ["delete", "user.created", "--yes"])).toBe(0);
    expect(method("events.remove")).toHaveBeenCalledWith("user.created");
  });
});
