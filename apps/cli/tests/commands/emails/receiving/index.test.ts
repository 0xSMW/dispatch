import { beforeEach, describe, expect, it, vi } from "vitest";
import { receiving } from "../../../../src/commands/emails/receiving/index.js";
import { poll } from "../../../../src/commands/emails/receiving/listen.js";
import { requireClient } from "../../../../src/lib/client.js";
import { timing } from "../../../../src/lib/retry.js";
import { captureExit, err, errorJson, list, method, ok, run, setNonInteractive, spies } from "../../../helpers.js";

vi.mock("@dispatchmail/sdk", async () => (await import("../../../helpers.js")).sdk);

describe("emails receiving", () => {
  beforeEach(() => {
    setNonInteractive();
    captureExit();
  });

  it("lists by default", async () => {
    method("emails.receiving.list").mockResolvedValue(list([{ id: "rcv_1" }]));
    spies();
    expect(await run(receiving, [])).toBe(0);
    expect(method("emails.receiving.list")).toHaveBeenCalledWith({ limit: 10 });
  });

  it("get passes --html-format", async () => {
    spies();
    await run(receiving, ["get", "rcv_1", "--html-format", "cid"]);
    expect(method("emails.receiving.get")).toHaveBeenCalledWith("rcv_1", { htmlFormat: "cid" });
  });

  it("forward requires --to and --from without a terminal", async () => {
    const { stderr } = spies();
    expect(await run(receiving, ["forward", "rcv_1"])).toBe(1);
    expect(errorJson(stderr()).error.message).toBe("Missing required flags: --to, --from");
    method("emails.receiving.forward").mockResolvedValue(ok({ id: "email_9" }));
    spies();
    await run(receiving, ["forward", "rcv_1", "--to", "a@x.com", "--from", "in@acme.com"]);
    expect(method("emails.receiving.forward")).toHaveBeenCalledWith({ emailId: "rcv_1", to: ["a@x.com"], from: "in@acme.com" });
  });

  it("simulate keeps the old local defaults", async () => {
    spies();
    await run(receiving, ["simulate"]);
    expect(method("emails.receiving.simulate")).toHaveBeenCalledWith({
      from: "sender@example.net",
      to: "inbound@example.com",
      subject: "Inbound local test",
      text: "This received email was simulated locally.",
      headers: {},
      attachments: [],
    });
  });

  it("listen rejects an interval under 2 seconds", async () => {
    const { stderr } = spies();
    expect(await run(receiving, ["listen", "--interval", "1"])).toBe(1);
    expect(errorJson(stderr()).error.code).toBe("invalid_interval");
  });

  it("poll prints only new emails as NDJSON and stops after five failures", async () => {
    vi.spyOn(timing, "sleep").mockResolvedValue(undefined);
    const { stdout } = spies();
    method("emails.receiving.list")
      .mockResolvedValueOnce(list([{ id: "rcv_1", from: "a", to: ["b"], subject: "old" }]))
      .mockResolvedValueOnce(list([{ id: "rcv_2", from: "a", to: ["b"], subject: "new" }, { id: "rcv_1" }]))
      .mockResolvedValue(err("application_error", null, "offline"));
    const api = requireClient({});
    await expect(poll({ api, interval: 2, globals: {}, stopped: () => false })).rejects.toMatchObject({ message: "offline" });
    const lines = stdout()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    expect(lines).toEqual([{ id: "rcv_2", from: "a", to: ["b"], subject: "new" }]);
    expect(method("emails.receiving.list")).toHaveBeenCalledTimes(7);
  });
});
