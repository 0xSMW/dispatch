import { beforeEach, describe, expect, it, vi } from "vitest";
import { program } from "../../../src/program.js";
import { tree } from "../../../src/lib/tree.js";
import { captureExit, err, errorJson, list, method, ok, run, setInteractive, setNonInteractive, spies } from "../../helpers.js";

vi.mock("@dispatchmail/sdk", async () => (await import("../../helpers.js")).sdk);

const preset = {
  slug: "onboarding-drip", name: "Onboarding drip", stage: "onboarding",
  description: "Help a new contact finish setup.", when: "Start when a contact is added.",
  trigger_config: { type: "contact_created" }, reentry: "once",
  events: [], properties: [{ key: "activated", type: "boolean" }],
  steps: [{ key: "start", type: "trigger", config: { type: "contact_created" } }],
  connections: [], templates: ["welcome"],
};

describe("templates library dispatch", () => {
  beforeEach(() => {
    setNonInteractive();
    captureExit();
    program.setOptionValue("json", false);
    program.setOptionValue("quiet", false);
  });

  it("preserves the bare template library list and JSON envelope", async () => {
    const data = { object: "list", has_more: false, data: [{ slug: "welcome", stage: "onboarding", when: "Welcome a user." }] };
    method("templates.library.list").mockResolvedValue(ok(data));
    const { stdout } = spies();
    expect(await run(program, ["templates", "library"])).toBe(0);
    expect(method("templates.library.list")).toHaveBeenCalledExactlyOnceWith();
    expect(method("templates.library.automations")).not.toHaveBeenCalled();
    expect(JSON.parse(stdout())).toEqual(data);
  });

  it("preserves the bare template library human table", async () => {
    setInteractive();
    method("templates.library.list").mockResolvedValue(list([
      { slug: "welcome", name: "Welcome", category: "auth", description: "Welcome a user." },
    ]));
    const { stdout } = spies();
    expect(await run(program, ["templates", "library"])).toBe(0);
    for (const label of ["Slug", "Name", "Category", "Description", "welcome", "Welcome", "auth", "Welcome a user."]) {
      expect(stdout()).toContain(label);
    }
    expect(method("templates.library.automations")).not.toHaveBeenCalled();
  });

  it.each([{ data: [] }, { data: [preset] }])("dispatches the preset list with unchanged JSON: %j", async ({ data }) => {
    method("templates.library.automations").mockResolvedValue(list(data));
    const { stdout } = spies();
    expect(await run(program, ["templates", "library", "automations"])).toBe(0);
    expect(method("templates.library.automations")).toHaveBeenCalledExactlyOnceWith();
    expect(method("templates.library.list")).not.toHaveBeenCalled();
    expect(JSON.parse(stdout())).toEqual({ object: "list", has_more: false, data });
  });

  it("renders slug, name, stage, description and when in a human list", async () => {
    setInteractive();
    method("templates.library.automations").mockResolvedValue(list([preset]));
    const { stdout } = spies();
    expect(await run(program, ["templates", "library", "automations"])).toBe(0);
    for (const label of ["Slug", "Name", "Stage", "Description", "When", preset.slug, preset.name, preset.stage, preset.description, preset.when]) {
      expect(stdout()).toContain(label);
    }
    expect(stdout()).not.toContain('"object"');
  });

  it("keeps terminal controls out of human preset tables", async () => {
    setInteractive();
    method("templates.library.automations").mockResolvedValue(list([{ ...preset, name: "\u001b[2JOnboarding drip" }]));
    const { stdout } = spies();
    expect(await run(program, ["templates", "library", "automations"])).toBe(0);
    expect(stdout()).toContain("Onboarding drip");
    expect(stdout()).not.toContain("\u001b[2J");
  });

  it("preserves --json in an interactive terminal", async () => {
    setInteractive();
    method("templates.library.automations").mockResolvedValue(list([preset]));
    const { stdout } = spies();
    expect(await run(program, ["--json", "templates", "library", "automations"])).toBe(0);
    expect(JSON.parse(stdout())).toEqual({ object: "list", has_more: false, data: [preset] });
  });

  it("gets a preset by the literal slug and prints the detail envelope as JSON", async () => {
    const detail = { object: "automation_preset", ...preset };
    method("templates.library.automation").mockResolvedValue(ok(detail));
    const { stdout } = spies();
    expect(await run(program, ["templates", "library", "automation", "onboarding/drip ?#%"])).toBe(0);
    expect(method("templates.library.automation")).toHaveBeenCalledExactlyOnceWith("onboarding/drip ?#%");
    expect(method("templates.library.list")).not.toHaveBeenCalled();
    expect(method("templates.library.automations")).not.toHaveBeenCalled();
    expect(JSON.parse(stdout())).toEqual(detail);
  });

  it("uses the normal human record output for a preset detail", async () => {
    setInteractive();
    method("templates.library.automation").mockResolvedValue(ok({ object: "automation_preset", ...preset }));
    const { stdout } = spies();
    expect(await run(program, ["templates", "library", "automation", preset.slug])).toBe(0);
    for (const value of [preset.slug, preset.name, preset.stage, preset.when, "contact_created", "welcome"]) {
      expect(stdout()).toContain(value);
    }
  });

  it("propagates not_found through the existing CLI error envelope", async () => {
    method("templates.library.automation").mockResolvedValue(err("not_found", 404, "Preset not found"));
    const { stdout, stderr } = spies();
    expect(await run(program, ["templates", "library", "automation", "missing"])).toBe(1);
    expect(stdout()).toBe("");
    expect(errorJson(stderr())).toEqual({ error: { code: "not_found", statusCode: 404, message: "Preset not found" } });
  });

  it("discovers only list/detail preset commands, not a future installer", () => {
    const root = tree(program);
    const library = root.subcommands.find((item) => item.name === "templates")!.subcommands.find((item) => item.name === "library")!;
    expect(library.subcommands.map((item) => item.name)).toEqual(["automations", "automation"]);
  });
});
