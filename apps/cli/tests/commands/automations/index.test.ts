import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { automations } from "../../../src/commands/automations/index.js";
import { captureExit, errorJson, list, method, run, setNonInteractive, spies } from "../../helpers.js";

vi.mock("@dispatchmail/sdk", async () => (await import("../../helpers.js")).sdk);

const dir = mkdtempSync(join(tmpdir(), "dispatch-automations-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("automations", () => {
  beforeEach(() => {
    setNonInteractive();
    captureExit();
  });

  it("lists by default with a status filter", async () => {
    method("automations.list").mockResolvedValue(list([]));
    spies();
    await run(automations, ["--status", "enabled"]);
    expect(method("automations.list")).toHaveBeenCalledWith({ limit: 10, status: "enabled" });
  });

  it("create merges a --file definition with flags", async () => {
    const file = join(dir, "flow.json");
    writeFileSync(file, JSON.stringify({ name: "From file", trigger: "user.created", steps: [{ type: "send_email" }] }));
    spies();
    await run(automations, ["create", "--file", file, "--status", "disabled"]);
    expect(method("automations.create")).toHaveBeenCalledWith({
      name: "From file",
      trigger: "user.created",
      steps: [{ type: "send_email" }],
      status: "disabled",
    });
  });

  it("create without steps fails with missing_flags", async () => {
    const { stderr } = spies();
    expect(await run(automations, ["create", "Onboarding", "--trigger", "user.created"])).toBe(1);
    expect(errorJson(stderr()).error.code).toBe("missing_flags");
  });

  it("update, duplicate, stop, get, and delete", async () => {
    spies();
    await run(automations, ["update", "auto_1", "--status", "enabled"]);
    expect(method("automations.update")).toHaveBeenCalledWith("auto_1", { status: "enabled" });
    await run(automations, ["duplicate", "auto_1"]);
    expect(method("automations.duplicate")).toHaveBeenCalledWith("auto_1");
    expect(await run(automations, ["stop", "auto_1"])).toBe(1);
    await run(automations, ["stop", "auto_1", "--yes"]);
    expect(method("automations.stop")).toHaveBeenCalledWith("auto_1");
    await run(automations, ["get", "auto_1"]);
    expect(method("automations.get")).toHaveBeenCalledWith("auto_1");
    expect(await run(automations, ["delete", "auto_1", "--yes"])).toBe(0);
  });

  it("runs list by default and runs get takes flags or positionals", async () => {
    method("automations.runs.list").mockResolvedValue(list([]));
    spies();
    await run(automations, ["runs", "auto_1", "--status", "failed"]);
    expect(method("automations.runs.list")).toHaveBeenCalledWith("auto_1", { limit: 10, status: "failed" });
    await run(automations, ["runs", "get", "--automation-id", "auto_1", "--run-id", "run_1"]);
    expect(method("automations.runs.get")).toHaveBeenCalledWith("auto_1", "run_1");
    await run(automations, ["runs", "get", "auto_2", "run_2"]);
    expect(method("automations.runs.get")).toHaveBeenLastCalledWith("auto_2", "run_2");
  });
});
