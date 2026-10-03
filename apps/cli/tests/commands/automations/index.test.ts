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

  it.each(["once", "every_time"])("creates and updates with explicit reentry %s", async (reentry) => {
    spies();
    expect(await run(automations, ["create", "Welcome", "--trigger", "user.created", "--steps", "[]", "--reentry", reentry])).toBe(0);
    expect(method("automations.create")).toHaveBeenCalledWith({
      name: "Welcome", trigger: "user.created", steps: [], reentry,
    });
    expect(await run(automations, ["update", "auto_1", "--reentry", reentry])).toBe(0);
    expect(method("automations.update")).toHaveBeenCalledWith("auto_1", { reentry });
  });

  it("preserves file reentry when omitted and allows a flag override", async () => {
    const file = join(dir, "reentry.json");
    writeFileSync(file, JSON.stringify({ name: "Welcome", trigger: "user.created", steps: [], reentry: "every_time" }));
    spies();
    expect(await run(automations, ["create", "--file", file])).toBe(0);
    expect(method("automations.create")).toHaveBeenLastCalledWith({
      name: "Welcome", trigger: "user.created", steps: [], reentry: "every_time",
    });
    expect(await run(automations, ["create", "--file", file, "--reentry", "once"])).toBe(0);
    expect(method("automations.create")).toHaveBeenLastCalledWith({
      name: "Welcome", trigger: "user.created", steps: [], reentry: "once",
    });
  });

  it.each([
    ["contact_created", [], { type: "contact_created" }],
    ["contact_updated", [], { type: "contact_updated" }],
    ["topic_subscribed", ["--topic", "topic_1"], { type: "topic_subscribed", topic_id: "topic_1" }],
    ["segment_added", ["--segment", "seg_1"], { type: "segment_added", segment_id: "seg_1" }],
    ["event", ["--trigger", "user.created"], { type: "event", event_name: "user.created" }],
  ])("creates a %s trigger with linear steps", async (type, flags, config) => {
    spies();
    expect(await run(automations, ["create", "Welcome", "--trigger-type", type, ...flags, "--steps", '[{"type":"wait","event_name":"user.activated"}]'])).toBe(0);
    expect(method("automations.create")).toHaveBeenCalledWith({
      name: "Welcome",
      steps: [
        { key: "trigger", type: "trigger", config },
        { key: "step_1", type: "wait_for_event", config: { event_name: "user.activated" } },
      ],
      connections: [{ from: "trigger", to: "step_1", type: "default" }],
    });
  });

  it("contact flags replace a file event trigger without changing graph keys or connections", async () => {
    const file = join(dir, "graph.json");
    const connections = [{ from: "start", to: "later", type: "default" }];
    writeFileSync(file, JSON.stringify({
      name: "Newsletter",
      trigger: "user.created",
      steps: [
        { key: "start", type: "trigger", config: { event_name: "user.created" } },
        { key: "later", type: "delay", config: { duration: "1 hour" } },
      ],
      connections,
    }));
    spies();
    await run(automations, ["create", "--file", file, "--trigger-type", "topic_subscribed", "--topic", "topic_2"]);
    expect(method("automations.create")).toHaveBeenCalledWith({
      name: "Newsletter",
      steps: [
        { key: "start", type: "trigger", config: { type: "topic_subscribed", topic_id: "topic_2" } },
        { key: "later", type: "delay", config: { duration: "1 hour" } },
      ],
      connections,
    });
  });

  it("keeps exact typed contact_updated filters in a file", async () => {
    const file = join(dir, "change.json");
    const steps = [{ key: "start", type: "trigger", config: { type: "contact_updated", field: "activated", from: false, to: true } }];
    writeFileSync(file, JSON.stringify({ name: "Activation", steps, connections: [] }));
    spies();
    await run(automations, ["create", "--file", file, "--trigger-type", "contact_updated"]);
    expect(method("automations.create")).toHaveBeenCalledWith({ name: "Activation", steps, connections: [] });
  });

  it.each([
    [["--trigger-type", "event"], "missing_flags"],
    [["--trigger-type", "topic_subscribed"], "missing_flags"],
    [["--trigger-type", "segment_added"], "missing_flags"],
    [["--trigger-type", "contact_created", "--trigger", "user.created"], "validation_error"],
    [["--trigger-type", "contact_updated", "--topic", "topic_1"], "validation_error"],
    [["--topic", "topic_1"], "validation_error"],
    [["--trigger-type", "topic_subscribed", "--topic", "topic_1", "--segment", "seg_1"], "validation_error"],
  ])("rejects incomplete or conflicting trigger flags %j", async (flags, code) => {
    const { stderr } = spies();
    expect(await run(automations, ["create", "Welcome", ...flags, "--steps", '[{"type":"delay","duration":"1 hour"}]'])).toBe(1);
    expect(errorJson(stderr()).error.code).toBe(code);
    expect(method("automations.create")).not.toHaveBeenCalled();
  });

  it.each([
    ['[null]'],
    ['[{"key":"start","type":"trigger"},{"type":"delay","duration":"1 hour"}]'],
    ['[{"key":"later","type":"delay","config":{"duration":"1 hour"}}]'],
  ])("rejects invalid contact-trigger step shapes %s", async (steps) => {
    const { stderr } = spies();
    expect(await run(automations, ["create", "Welcome", "--trigger-type", "contact_created", "--steps", steps])).toBe(1);
    expect(errorJson(stderr()).error.code).toBe("validation_error");
    expect(method("automations.create")).not.toHaveBeenCalled();
  });

  it("renders contact triggers in words and keeps legacy event labels", async () => {
    method("automations.list").mockResolvedValue(list([
      { id: "auto_1", name: "New", trigger: null, trigger_config: { type: "contact_created" } },
      { id: "auto_2", name: "Change", trigger: null, trigger_config: { type: "contact_updated", field: "activated", from: false, to: true } },
      { id: "auto_3", name: "Topic", trigger: null, trigger_config: { type: "topic_subscribed", topic_id: "topic_1" } },
      { id: "auto_4", name: "Segment", trigger: null, trigger_config: { type: "segment_added", segment_id: "seg_1" } },
      { id: "auto_5", name: "Legacy", trigger: "user.created" },
      { id: "auto_6", name: "Any", trigger: null, trigger_config: { type: "contact_updated" } },
      { id: "auto_7", name: "Event", trigger: "old", trigger_config: { type: "event", event_name: "user.activated" } },
      { id: "auto_8", name: "Clear", trigger: null, trigger_config: { type: "contact_updated", field: "plan", to: null } },
    ]));
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true, writable: true });
    const { stdout } = spies();
    expect(await run(automations, ["list"])).toBe(0);
    expect(stdout()).toContain("Contact added");
    expect(stdout()).toContain("Contact changes: activated from false to true");
    expect(stdout()).toContain("Subscribed to topic: topic_1");
    expect(stdout()).toContain("Added to segment: seg_1");
    expect(stdout()).toContain("user.created");
    expect(stdout()).toContain("Contact changes: any change");
    expect(stdout()).toContain("user.activated");
    expect(stdout()).toContain("Contact changes: plan to null");
    expect(stdout()).not.toContain("@");
  });

  it("updates an event trigger or an exact typed contact trigger graph", async () => {
    spies();
    await run(automations, ["update", "auto_1", "--trigger", "user.activated"]);
    expect(method("automations.update")).toHaveBeenCalledWith("auto_1", { trigger: "user.activated" });
    const steps = [{ key: "start", type: "trigger", config: { type: "contact_updated", field: "project_count", from: 0, to: 3 } }];
    await run(automations, ["update", "auto_1", "--steps", JSON.stringify(steps), "--connections", "[]"]);
    expect(method("automations.update")).toHaveBeenLastCalledWith("auto_1", { steps, connections: [] });
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

  it("stop resets reentry only when requested and still requires confirmation", async () => {
    spies();
    expect(await run(automations, ["stop", "auto_1", "--reset-reentry"])).toBe(1);
    expect(method("automations.stop")).not.toHaveBeenCalled();
    expect(await run(automations, ["stop", "auto_1", "--yes", "--reset-reentry"])).toBe(0);
    expect(method("automations.stop")).toHaveBeenLastCalledWith("auto_1", { resetReentry: true });
    expect(await run(automations, ["stop", "auto_1", "--yes"])).toBe(0);
    expect(method("automations.stop")).toHaveBeenLastCalledWith("auto_1");
  });
});
