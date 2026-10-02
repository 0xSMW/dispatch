import { beforeEach, describe, expect, it, vi } from "vitest";
import { logs } from "../../../src/commands/logs/index.js";
import { captureExit, list, method, ok, run, setNonInteractive, spies } from "../../helpers.js";

vi.mock("@dispatchmail/sdk", async () => (await import("../../helpers.js")).sdk);

describe("logs", () => {
  beforeEach(() => {
    setNonInteractive();
    captureExit();
  });

  it("lists by default with filters", async () => {
    method("logs.list").mockResolvedValue(list([]));
    spies();
    await run(logs, ["--status", "422", "--user-agent", "curl", "--from", "2026-10-01"]);
    expect(method("logs.list")).toHaveBeenCalledWith({ limit: 10, status: "422", user_agent: "curl", from: "2026-10-01" });
  });

  it("get, export, and open", async () => {
    method("logs.export").mockResolvedValue(ok({ data: [] }));
    const { stdout } = spies();
    await run(logs, ["get", "log_1"]);
    expect(method("logs.get")).toHaveBeenCalledWith("log_1");
    await run(logs, ["export"]);
    expect(method("logs.export")).toHaveBeenCalled();
    await run(logs, ["open", "log_1"]);
    expect(stdout()).toContain('"url": "http://localhost:5173/logs/log_1"');
  });
});
