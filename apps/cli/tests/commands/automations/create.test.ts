import { beforeEach, describe, expect, it, vi } from "vitest";
import { automations } from "../../../src/commands/automations/index.js";
import { create } from "../../../src/commands/automations/create.js";
import { captureExit, err, errorJson, method, ok, run, setNonInteractive, spies } from "../../helpers.js";

vi.mock("@dispatchmail/sdk", async () => (await import("../../helpers.js")).sdk);

const installation = {
  automation: { object: "automation", id: "auto_installed", name: "Onboarding drip", status: "disabled", version: 1,
    trigger: null, trigger_config: { type: "contact_created" }, reentry: "once", steps: [], connections: [],
    created_at: "2026-10-05T00:00:00Z", updated_at: "2026-10-05T00:00:00Z" },
  templates: { created: [], reused: [] }, events: [], properties: [],
  next_steps: ["Choose a topic for marketing steps", "Review the automation and its emails", "Enable the automation"],
  request_id: "req_install",
};

describe("automations create preset", () => {
  beforeEach(() => { setNonInteractive(); captureExit(); });

  it("explains disabled installs, server-default names, required sender and newsletter topic in help", () => {
    const help = create.helpInformation().replace(/\s+/g, " ");
    expect(help).toContain("--preset <slug>");
    expect(help).toContain("Install a library preset disabled");
    expect(help).toContain("name defaults to the preset name");
    expect(help).toContain("required with --preset");
    expect(help).toContain("required for newsletter-welcome");
    expect(help).toContain("otherwise topic_subscribed trigger topic");
    expect(method("templates.library.installAutomation")).not.toHaveBeenCalled();
  });

  it("leaves the name default to the server without prompts, files or steps and preserves JSON", async () => {
    method("templates.library.installAutomation").mockResolvedValue(ok(installation));
    const { stdout } = spies();
    expect(await run(automations, ["create", "--preset", "onboarding-drip", "--from", "Acme <you@acme.com>"])).toBe(0);
    expect(method("templates.library.installAutomation")).toHaveBeenCalledWith("onboarding-drip", { from: "Acme <you@acme.com>" });
    expect(method("automations.create")).not.toHaveBeenCalled();
    expect(JSON.parse(stdout())).toEqual(installation);
  });

  it.each([{ nameArgs: ["Custom"] }, { nameArgs: ["--name", "Custom"] }])("accepts a custom name $nameArgs and Marketing topic", async ({ nameArgs }) => {
    method("templates.library.installAutomation").mockResolvedValue(ok(installation));
    spies();
    expect(await run(automations, ["create", ...nameArgs, "--preset", "newsletter-welcome", "--from", "you@acme.com", "--topic", "topic_123"])).toBe(0);
    expect(method("templates.library.installAutomation")).toHaveBeenCalledWith("newsletter-welcome", { name: "Custom", from: "you@acme.com", topicId: "topic_123" });
  });

  it("uses the nested automation ID in human output", async () => {
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    method("templates.library.installAutomation").mockResolvedValue(ok(installation));
    const { stdout } = spies();
    expect(await run(automations, ["create", "--preset", "onboarding-drip", "--from", "you@acme.com"])).toBe(0);
    expect(stdout()).toContain("Created automation auto_installed");
    expect(stdout()).not.toContain("undefined");
  });

  it("requires a sender before making any request", async () => {
    const { stderr } = spies();
    expect(await run(automations, ["create", "--preset", "onboarding-drip"])).toBe(1);
    expect(errorJson(stderr()).error.code).toBe("missing_flags");
    expect(method("templates.library.installAutomation")).not.toHaveBeenCalled();
  });

  it.each([
    ["--steps", "[]"], ["--connections", "[]"], ["--file", "/not/read.json"],
    ["--trigger", "user.created"], ["--trigger-type", "contact_created"],
    ["--segment", "seg_1"], ["--status", "disabled"], ["--reentry", "once"],
  ])("rejects incompatible %s instead of silently discarding it", async (flag, value) => {
    const { stderr } = spies();
    expect(await run(automations, ["create", "--preset", "onboarding-drip", "--from", "you@acme.com", flag, value])).toBe(1);
    expect(errorJson(stderr()).error).toMatchObject({ code: "validation_error", message: expect.stringContaining(flag) });
    expect(method("templates.library.installAutomation")).not.toHaveBeenCalled();
    expect(method("automations.create")).not.toHaveBeenCalled();
  });

  it.each([
    [403, "forbidden", "Access denied"], [409, "conflict", "Name already exists"],
    [422, "validation_error", "Choose a topic"],
  ])("propagates server %s errors without manufacturing a topic", async (status, code, message) => {
    method("templates.library.installAutomation").mockResolvedValue(err(code as string, status as number, message as string));
    const { stderr } = spies();
    expect(await run(automations, ["create", "--preset", "newsletter-welcome", "--from", "you@acme.com"])).toBe(1);
    expect(errorJson(stderr()).error).toMatchObject({ code, message, statusCode: status });
    expect(method("templates.library.installAutomation")).toHaveBeenCalledWith("newsletter-welcome", { from: "you@acme.com" });
  });

  it("rejects preset sender flags in blank mode rather than dropping them", async () => {
    const { stderr } = spies();
    expect(await run(automations, ["create", "Blank", "--from", "you@acme.com", "--steps", "[]"])).toBe(1);
    expect(errorJson(stderr()).error.code).toBe("validation_error");
    expect(method("automations.create")).not.toHaveBeenCalled();
  });
});
