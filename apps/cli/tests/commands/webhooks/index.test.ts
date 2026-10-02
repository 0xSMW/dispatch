import { beforeEach, describe, expect, it, vi } from "vitest";
import { webhooks } from "../../../src/commands/webhooks/index.js";
import { captureExit, errorJson, list, method, ok, run, setNonInteractive, spies } from "../../helpers.js";

vi.mock("@dispatchmail/sdk", async () => (await import("../../helpers.js")).sdk);

describe("webhooks", () => {
  beforeEach(() => {
    setNonInteractive();
    captureExit();
  });

  it("lists by default", async () => {
    method("webhooks.list").mockResolvedValue(list([]));
    spies();
    expect(await run(webhooks, [])).toBe(0);
    expect(method("webhooks.list")).toHaveBeenCalledWith({ limit: 10 });
  });

  it("create takes --endpoint or the positional URL, and events default to all", async () => {
    method("webhooks.create").mockResolvedValue(ok({ id: "wh_1", signing_secret: "whsec_1" }));
    spies();
    await run(webhooks, ["create", "https://acme.com/hooks"]);
    expect(method("webhooks.create")).toHaveBeenLastCalledWith({ endpoint: "https://acme.com/hooks", events: ["all"] });
    await run(webhooks, ["create", "--endpoint", "https://acme.com/h2", "--events", "email.sent,email.bounced"]);
    expect(method("webhooks.create")).toHaveBeenLastCalledWith({
      endpoint: "https://acme.com/h2",
      events: ["email.sent", "email.bounced"],
    });
  });

  it("get, update, rotate, test, and delete", async () => {
    spies();
    await run(webhooks, ["get", "wh_1"]);
    expect(method("webhooks.get")).toHaveBeenCalledWith("wh_1");
    await run(webhooks, ["update", "wh_1", "--status", "disabled"]);
    expect(method("webhooks.update")).toHaveBeenCalledWith("wh_1", { status: "disabled" });
    await run(webhooks, ["rotate-signing-secret", "wh_1"]);
    expect(method("webhooks.rotateSigningSecret")).toHaveBeenCalledWith("wh_1");
    await run(webhooks, ["test"]);
    expect(method("webhooks.test")).toHaveBeenCalled();
    expect(await run(webhooks, ["delete", "wh_1", "--yes"])).toBe(0);
    expect(method("webhooks.remove")).toHaveBeenCalledWith("wh_1");
  });

  it("events list, get, and attempts hang off the webhook", async () => {
    method("webhooks.events.list").mockResolvedValue(list([]));
    method("webhooks.events.attempts").mockResolvedValue(list([]));
    spies();
    await run(webhooks, ["events", "wh_1"]);
    expect(method("webhooks.events.list")).toHaveBeenCalledWith("wh_1", { limit: 10 });
    await run(webhooks, ["events", "get", "wh_1", "evt_1"]);
    expect(method("webhooks.events.get")).toHaveBeenCalledWith("wh_1", "evt_1");
    await run(webhooks, ["events", "attempts", "wh_1", "evt_1"]);
    expect(method("webhooks.events.attempts")).toHaveBeenCalledWith("wh_1", "evt_1", { limit: 10 });
  });

  it("events replay picks the latest failed event when none is given", async () => {
    method("webhooks.events.list").mockResolvedValue(
      list([
        { id: "evt_3", status: "delivered" },
        { id: "evt_2", status: "failed" },
      ]),
    );
    spies();
    await run(webhooks, ["events", "replay", "wh_1"]);
    expect(method("webhooks.events.replay")).toHaveBeenCalledWith("wh_1", "evt_2");
    await run(webhooks, ["events", "replay", "wh_1", "--event", "evt_9"]);
    expect(method("webhooks.events.replay")).toHaveBeenLastCalledWith("wh_1", "evt_9");
  });

  it("events replay does not redeliver a delivered event when none failed", async () => {
    method("webhooks.events.list").mockResolvedValue(list([{ id: "evt_3", status: "delivered" }]));
    const { stderr } = spies();
    expect(await run(webhooks, ["events", "replay", "wh_1"])).toBe(1);
    expect(errorJson(stderr()).error.code).toBe("not_found");
    expect(method("webhooks.events.replay")).not.toHaveBeenCalled();
  });

  it("listen requires --url when the API is not local", async () => {
    process.env.DISPATCH_API_URL = "https://mail.example.com";
    process.env.DISPATCH_API_KEY = "sk_1";
    const { stderr } = spies();
    expect(await run(webhooks, ["listen"])).toBe(1);
    expect(errorJson(stderr()).error.code).toBe("missing_url");
    expect(method("webhooks.create")).not.toHaveBeenCalled();
  });
});
