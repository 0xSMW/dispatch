import { beforeEach, describe, expect, it, vi } from "vitest";
import { broadcasts } from "../../../src/commands/broadcasts/index.js";
import { captureExit, errorJson, list, method, ok, run, setNonInteractive, spies } from "../../helpers.js";

vi.mock("@dispatchmail/sdk", async () => (await import("../../helpers.js")).sdk);

describe("broadcasts", () => {
  beforeEach(() => {
    setNonInteractive();
    captureExit();
  });

  it("lists by default", async () => {
    method("broadcasts.list").mockResolvedValue(list([]));
    spies();
    expect(await run(broadcasts, [])).toBe(0);
    expect(method("broadcasts.list")).toHaveBeenCalledWith({ limit: 10 });
  });

  it("create maps flags, including the old --segment and --topic names", async () => {
    method("broadcasts.create").mockResolvedValue(ok({ id: "bc_1" }));
    spies();
    await run(broadcasts, [
      "create",
      "October",
      "--from",
      "news@acme.com",
      "--subject",
      "News",
      "--html",
      "<p>x</p>",
      "--segment",
      "seg_1",
      "--topic-id",
      "top_1",
    ]);
    expect(method("broadcasts.create")).toHaveBeenCalledWith({
      name: "October",
      from: "news@acme.com",
      subject: "News",
      html: "<p>x</p>",
      segmentId: "seg_1",
      topicId: "top_1",
    });
  });

  it("create --send --scheduled-at sends in the same call", async () => {
    method("broadcasts.create").mockResolvedValue(ok({ id: "bc_2" }));
    spies();
    await run(broadcasts, ["create", "--from", "a@acme.com", "--subject", "S", "--text", "T", "--send", "--scheduled-at", "tomorrow 9am"]);
    expect(method("broadcasts.create").mock.calls[0]![0]).toMatchObject({ send: true, scheduledAt: "tomorrow 9am" });
  });

  it("create --dry-run does not call the API, and a missing body fails", async () => {
    const { stdout } = spies();
    await run(broadcasts, ["create", "--from", "a@acme.com", "--subject", "S", "--text", "T", "--dry-run"]);
    expect(JSON.parse(stdout()).object).toBe("dry_run");
    expect(method("broadcasts.create")).not.toHaveBeenCalled();
    const { stderr } = spies();
    expect(await run(broadcasts, ["create", "--from", "a@acme.com", "--subject", "S"])).toBe(1);
    expect(errorJson(stderr()).error.code).toBe("missing_flags");
  });

  it("maps every single-broadcast command", async () => {
    method("broadcasts.recipients").mockResolvedValue(list([]));
    method("broadcasts.clickedLinks").mockResolvedValue(list([]));
    spies();
    await run(broadcasts, ["get", "bc_1"]);
    expect(method("broadcasts.get")).toHaveBeenCalledWith("bc_1");
    await run(broadcasts, ["update", "bc_1", "--subject", "New"]);
    expect(method("broadcasts.update")).toHaveBeenCalledWith("bc_1", { subject: "New" });
    await run(broadcasts, ["send", "bc_1", "--scheduled-at", "in 1 hour"]);
    expect(method("broadcasts.send")).toHaveBeenCalledWith("bc_1", { scheduledAt: "in 1 hour" });
    for (const verb of ["cancel", "pause", "resume"]) await run(broadcasts, [verb, "bc_1"]);
    expect(method("broadcasts.cancel")).toHaveBeenCalledWith("bc_1");
    expect(method("broadcasts.pause")).toHaveBeenCalledWith("bc_1");
    expect(method("broadcasts.resume")).toHaveBeenCalledWith("bc_1");
    await run(broadcasts, ["duplicate", "bc_1"]);
    expect(method("broadcasts.duplicate")).toHaveBeenCalledWith("bc_1", {});
    await run(broadcasts, ["recipients", "bc_1", "--type", "bounced", "--bounce-type", "hard"]);
    expect(method("broadcasts.recipients")).toHaveBeenCalledWith("bc_1", { type: "bounced", bounceType: "hard", limit: 10 });
    await run(broadcasts, ["clicked-links", "bc_1"]);
    expect(method("broadcasts.clickedLinks")).toHaveBeenCalledWith("bc_1", { limit: 10 });
    expect(await run(broadcasts, ["delete", "bc_1", "--yes"])).toBe(0);
    expect(method("broadcasts.remove")).toHaveBeenCalledWith("bc_1");
  });

  it("open prints the dashboard URL without a terminal", async () => {
    process.env.APP_URL = "https://app.acme.com";
    const { stdout } = spies();
    await run(broadcasts, ["open", "bc_1"]);
    expect(JSON.parse(stdout())).toEqual({ url: "https://app.acme.com/broadcasts/bc_1", opened: false });
  });
});
