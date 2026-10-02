import { beforeEach, describe, expect, it, vi } from "vitest";
import { topics } from "../../../src/commands/topics/index.js";
import { captureExit, method, run, setNonInteractive, spies } from "../../helpers.js";

vi.mock("@dispatchmail/sdk", async () => (await import("../../helpers.js")).sdk);

beforeEach(() => {
  setNonInteractive();
  captureExit();
});

describe("topics", () => {
  it("create maps --default-subscription and the old --default flag", async () => {
    spies();
    await run(topics, ["create", "News", "--default-subscription", "opt_out", "--visibility", "public"]);
    expect(method("topics.create")).toHaveBeenLastCalledWith({ name: "News", defaultSubscription: "opt_out", visibility: "public" });
    await run(topics, ["create", "--name", "Updates", "--default", "subscribed"]);
    expect(method("topics.create")).toHaveBeenLastCalledWith({ name: "Updates", defaultSubscription: "opt_in" });
  });

  it("get, update, and delete", async () => {
    spies();
    await run(topics, ["get", "top_1"]);
    expect(method("topics.get")).toHaveBeenCalledWith("top_1");
    await run(topics, ["update", "top_1", "--description", "Monthly"]);
    expect(method("topics.update")).toHaveBeenCalledWith({ id: "top_1", description: "Monthly" });
    expect(await run(topics, ["delete", "top_1", "--yes"])).toBe(0);
  });
});
