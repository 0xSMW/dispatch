import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { contacts } from "../../../src/commands/contacts/index.js";
import { activity } from "../../../src/commands/contacts/activity.js";
import { parseTopics } from "../../../src/commands/contacts/update-topics.js";
import { captureExit, errorJson, list, method, run, setInteractive, setNonInteractive, spies } from "../../helpers.js";

vi.mock("@dispatchmail/sdk", async () => (await import("../../helpers.js")).sdk);

const dir = mkdtempSync(join(tmpdir(), "dispatch-contacts-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("contacts", () => {
  beforeEach(() => {
    setNonInteractive();
    captureExit();
  });

  it("lists by default with a segment filter", async () => {
    method("contacts.list").mockResolvedValue(list([]));
    spies();
    await run(contacts, ["--segment-id", "seg_1"]);
    expect(method("contacts.list")).toHaveBeenCalledWith({ limit: 10, segmentId: "seg_1" });
  });

  it("create accepts the new and old name flags", async () => {
    spies();
    await run(contacts, ["create", "ada@example.com", "--first-name", "Ada", "--last", "Lovelace", "--segment-id", "seg_1"]);
    expect(method("contacts.create")).toHaveBeenCalledWith({
      email: "ada@example.com",
      firstName: "Ada",
      lastName: "Lovelace",
      segments: [{ id: "seg_1" }],
    });
  });

  it("update and segment membership take an ID or an email", async () => {
    spies();
    await run(contacts, ["update", "ada@example.com", "--no-unsubscribed", "--properties", '{"plan":"pro"}']);
    expect(method("contacts.update")).toHaveBeenCalledWith({ email: "ada@example.com", unsubscribed: false, properties: { plan: "pro" } });
    await run(contacts, ["add-segment", "ct_1", "--segment-id", "seg_1"]);
    expect(method("contacts.segments.add")).toHaveBeenCalledWith({ id: "ct_1", segmentId: "seg_1" });
    await run(contacts, ["remove-segment", "ada@example.com", "--segment-id", "seg_1"]);
    expect(method("contacts.segments.remove")).toHaveBeenCalledWith({ email: "ada@example.com", segmentId: "seg_1" });
  });

  it("lists segments, topics, and activity for one contact", async () => {
    for (const path of ["contacts.segments.list", "contacts.topics.list", "contacts.activity"]) method(path).mockResolvedValue(list([]));
    spies();
    await run(contacts, ["segments", "ada@example.com"]);
    expect(method("contacts.segments.list")).toHaveBeenCalledWith({ email: "ada@example.com", limit: 10 });
    await run(contacts, ["topics", "ct_1"]);
    expect(method("contacts.topics.list")).toHaveBeenCalledWith({ id: "ct_1", limit: 10 });
    await run(contacts, ["activity", "ct_1"]);
    expect(method("contacts.activity")).toHaveBeenCalledWith("ct_1", { limit: 10 });
  });

  it("update-topics accepts JSON or the short form", async () => {
    expect(parseTopics("t1=opt_in,t2=opt_out")).toEqual([
      { id: "t1", subscription: "opt_in" },
      { id: "t2", subscription: "opt_out" },
    ]);
    expect(parseTopics('[{"id":"t1","subscription":"opt_out"}]')).toEqual([{ id: "t1", subscription: "opt_out" }]);
    expect(() => parseTopics("t1=maybe")).toThrowError(expect.objectContaining({ code: "invalid_flag" }));
    spies();
    await run(contacts, ["update-topics", "ada@example.com", "--topics", "t1=opt_out"]);
    expect(method("contacts.topics.update")).toHaveBeenCalledWith({
      email: "ada@example.com",
      topics: [{ id: "t1", subscription: "opt_out" }],
    });
  });

  it("describes events, automation runs, and email activity", () => {
    expect(activity.description()).toBe("Show a contact's events, automation runs, and email activity (Dispatch only)");
  });

  it("shows labels and run attribution alongside email activity in the table", async () => {
    setInteractive();
    method("contacts.activity").mockResolvedValue(list([
      { id: "fired_1", type: "event.fired", label: "user.joined", email_id: null, created_at: "2026-09-01T00:00:00.000Z" },
      { id: "run_1:started", type: "automation.run.started", label: "Onboarding", automation_id: "automation_1", run_id: "run_1", email_id: null, created_at: "2026-09-01T00:00:00.000Z" },
      ...["done", "failed", "stopped"].map((state) => ({
        id: `run_${state}:completed`, type: "automation.run.completed", label: state, automation_id: "automation_1", run_id: `run_${state}`, email_id: null, created_at: "2026-09-02T00:00:00.000Z",
      })),
      { id: "ev_1", type: "email.delivered", label: "Welcome", email_id: "email_1", created_at: "2026-09-02T00:00:00.000Z" },
    ]));
    const { stdout } = spies();
    expect(await run(contacts, ["activity", "ct_1"])).toBe(0);
    expect(method("contacts.activity")).toHaveBeenCalledWith("ct_1", { limit: 10 });
    const lines = stdout().split("\n").map((line) => line.replace(/\u001b\[[0-9;]*m/g, "").trim().split(/\s+/));
    expect(lines).toEqual([
      ["Type", "Label", "Automation", "Run", "Email", "At", "ID"],
      ["event.fired", "user.joined", "2026-09-01T00:00:00.000Z", "fired_1"],
      ["automation.run.started", "Onboarding", "automation_1", "run_1", "2026-09-01T00:00:00.000Z", "run_1:started"],
      ...["done", "failed", "stopped"].map((state) => ["automation.run.completed", state, "automation_1", `run_${state}`, "2026-09-02T00:00:00.000Z", `run_${state}:completed`]),
      ["email.delivered", "Welcome", "email_1", "2026-09-02T00:00:00.000Z", "ev_1"],
    ]);
  });

  it("delete needs --yes", async () => {
    const { stderr } = spies();
    expect(await run(contacts, ["delete", "ada@example.com"])).toBe(1);
    expect(errorJson(stderr()).error.code).toBe("confirmation_required");
    expect(await run(contacts, ["rm", "ada@example.com", "--yes"])).toBe(0);
    expect(method("contacts.remove")).toHaveBeenCalledWith("ada@example.com");
  });

  it("imports create reads the CSV and passes options", async () => {
    const file = join(dir, "people.csv");
    writeFileSync(file, "email\nada@example.com\n");
    method("contacts.imports.list").mockResolvedValue(list([]));
    spies();
    await run(contacts, ["imports", "create", "--file", file, "--on-conflict", "skip", "--segment-id", "seg_1"]);
    expect(method("contacts.imports.create")).toHaveBeenCalledWith({
      file: "email\nada@example.com\n",
      filename: "people.csv",
      onConflict: "skip",
      segments: [{ id: "seg_1" }],
    });
    await run(contacts, ["imports"]);
    expect(method("contacts.imports.list")).toHaveBeenCalledWith({ limit: 10 });
    await run(contacts, ["imports", "get", "imp_1"]);
    expect(method("contacts.imports.get")).toHaveBeenCalledWith("imp_1");
  });

  it.each([
    [[], undefined],
    [["--no-trigger-automations"], false],
    [["--trigger-automations"], true],
  ])("imports preserve the optional trigger-automations flag %j", async (flags, triggerAutomations) => {
    const file = join(dir, "triggers.csv");
    writeFileSync(file, "email\nada@example.com\n");
    spies();
    expect(await run(contacts, ["imports", "create", "--file", file, ...flags])).toBe(0);
    expect(method("contacts.imports.create")).toHaveBeenCalledWith({
      file: "email\nada@example.com\n",
      filename: "triggers.csv",
      ...(triggerAutomations === undefined ? {} : { triggerAutomations }),
    });
  });
});
