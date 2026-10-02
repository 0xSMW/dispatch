import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { variable } from "../../../src/commands/templates/body.js";
import { templates } from "../../../src/commands/templates/index.js";
import { captureExit, errorJson, list, method, ok, run, setNonInteractive, spies } from "../../helpers.js";

vi.mock("@dispatchmail/sdk", async () => (await import("../../helpers.js")).sdk);
const variables = [{ key: "NAME", prop: "name", type: "string", fallback_value: "there" }];

vi.mock("../../../src/lib/react.js", () => ({
  renderFile: vi.fn(async () => ({ html: "<p>{{{NAME}}}</p>", subject: "Welcome", variables })),
  loadFile: vi.fn(async () => ({
    subject: "Welcome",
    variables,
    track: undefined,
    brand: true,
    render: async () => "<p>{{{NAME}}}</p>",
  })),
}));

const dir = mkdtempSync(join(tmpdir(), "dispatch-templates-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("templates", () => {
  beforeEach(() => {
    setNonInteractive();
    captureExit();
  });

  it("lists by default", async () => {
    method("templates.list").mockResolvedValue(list([]));
    spies();
    expect(await run(templates, [])).toBe(0);
    expect(method("templates.list")).toHaveBeenCalledWith({ limit: 10 });
  });

  it("parses --var KEY:type:fallback", () => {
    expect(variable("NAME")).toEqual({ key: "NAME", type: "string", fallback_value: null });
    expect(variable("COUNT:number:3")).toEqual({ key: "COUNT", type: "number", fallback_value: 3 });
    expect(variable("URL:string:https://x.com/a")).toEqual({ key: "URL", type: "string", fallback_value: "https://x.com/a" });
    expect(() => variable("X:date")).toThrowError(expect.objectContaining({ code: "invalid_flag" }));
  });

  it("create sends a draft with declared variables", async () => {
    method("templates.create").mockResolvedValue(ok({ id: "tpl_1" }));
    spies();
    await run(templates, [
      "create",
      "Welcome",
      "--alias",
      "welcome",
      "--subject",
      "Hi {{{NAME}}}",
      "--html",
      "<p>x</p>",
      "--var",
      "NAME:string:there",
    ]);
    expect(method("templates.create")).toHaveBeenCalledWith({
      name: "Welcome",
      alias: "welcome",
      subject: "Hi {{{NAME}}}",
      html: "<p>x</p>",
      variables: [{ key: "NAME", type: "string", fallback_value: "there" }],
      publish: false,
    });
  });

  it("create --react-email takes subject, HTML, and variables from the component", async () => {
    method("templates.create").mockResolvedValue(ok({ id: "tpl_2" }));
    spies();
    await run(templates, ["create", "--name", "Welcome", "--react-email", "welcome.tsx", "--publish"]);
    expect(method("templates.create")).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: "Welcome",
        html: "<p>{{{NAME}}}</p>",
        variables: [{ key: "NAME", type: "string", fallback_value: "there" }],
        publish: true,
      }),
    );
  });

  it("create without a body fails with missing_flags", async () => {
    const { stderr } = spies();
    expect(await run(templates, ["create", "Welcome"])).toBe(1);
    expect(errorJson(stderr()).error.code).toBe("missing_flags");
  });

  it("get, update, publish, duplicate, render, and delete use the ID or alias", async () => {
    spies();
    await run(templates, ["get", "welcome"]);
    expect(method("templates.get")).toHaveBeenCalledWith("welcome");
    await run(templates, ["update", "welcome", "--name", "Hello", "--text", "Hi"]);
    expect(method("templates.update")).toHaveBeenCalledWith("welcome", { name: "Hello", text: "Hi" });
    await run(templates, ["publish", "welcome"]);
    expect(method("templates.publish")).toHaveBeenCalledWith("welcome", {});
    await run(templates, ["duplicate", "welcome", "--name", "Copy"]);
    expect(method("templates.duplicate")).toHaveBeenCalledWith("welcome", { name: "Copy" });
    await run(templates, ["render", "welcome", "--var", "NAME=Ada"]);
    expect(method("templates.render")).toHaveBeenCalledWith("welcome", { NAME: "Ada" });
    expect(await run(templates, ["rm", "welcome", "--yes"])).toBe(0);
    expect(method("templates.remove")).toHaveBeenCalledWith("welcome");
  });

  it("library lists and add installs by slug", async () => {
    method("templates.library.list").mockResolvedValue(list([{ slug: "password-reset" }]));
    spies();
    await run(templates, ["library"]);
    expect(method("templates.library.list")).toHaveBeenCalled();
    await run(templates, ["add", "password-reset"]);
    expect(method("templates.library.install")).toHaveBeenCalledWith("password-reset");
  });

  it("push renders a file and creates a draft through the SDK", async () => {
    const file = join(dir, "welcome.tsx");
    (await import("node:fs")).writeFileSync(file, "export default () => null");
    method("templates.get").mockResolvedValue({ data: null, error: { name: "not_found", statusCode: 404, message: "x" }, headers: {} });
    method("templates.create").mockResolvedValue(ok({ id: "tpl_3", current_version_id: "v_1" }));
    const { stdout } = spies();
    expect(await run(templates, ["push", file])).toBe(0);
    expect(method("templates.create")).toHaveBeenCalledWith(expect.objectContaining({ alias: "welcome", publish: false }));
    expect(JSON.parse(stdout())).toEqual([{ alias: "welcome", action: "created", id: "tpl_3", version_id: "v_1", status: "draft" }]);
  });

  it("eject copies a library template from packages/templates", async () => {
    const out = join(dir, "ejected");
    const { stdout } = spies();
    expect(await run(templates, ["eject", "password-reset", "--dir", out])).toBe(0);
    expect(JSON.parse(stdout())).toEqual({ object: "template", slug: "password-reset", dir: out });
    expect(readFileSync(join(out, "password-reset.tsx"), "utf8")).toContain("export default");
    expect(readFileSync(join(out, "_theme.ts"), "utf8").length).toBeGreaterThan(0);
  });
});
