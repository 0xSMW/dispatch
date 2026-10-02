import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const builds: Array<{ entry: string; outfile: string; plugins: Array<{ setup: (builder: unknown) => void }> }> = [];

vi.mock("esbuild", () => ({
  build: vi.fn(async (options: { entryPoints: string[]; outfile: string; plugins: Array<{ setup: (builder: unknown) => void }> }) => {
    builds.push({ entry: options.entryPoints[0]!, outfile: options.outfile, plugins: options.plugins });
    await writeFile(
      options.outfile,
      `exports.default = function Welcome() { return null; }
exports.default.Variables = [{ key: "NAME", prop: "name", type: "string", fallback_value: "there" }];
exports.default.Subject = "Welcome";
exports.default.PreviewProps = { name: "Ada" };
exports.__createElement = (_component, props) => props;
exports.__render = async (props) => "<p>" + props.name + "</p>";
`,
    );
  }),
}));

describe("renderFile", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    builds.length = 0;
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("renders the bundled component and returns its variables", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dispatch-react-file-"));
    dirs.push(dir);
    const file = join(dir, "welcome.tsx");
    await writeFile(file, "export default function Welcome() { return null }\n");
    const { renderFile } = await import("../../src/lib/react.js");
    const rendered = await renderFile(file, { name: "Ada" });
    expect(rendered.html).toBe("<p>Ada</p>");
    expect(rendered.subject).toBe("Welcome");
    expect(rendered.variables[0]).toMatchObject({ key: "NAME", prop: "name" });
  });

  it("uses PreviewProps when the caller omits props", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dispatch-react-file-"));
    dirs.push(dir);
    const file = join(dir, "welcome.tsx");
    await writeFile(file, "export default function Welcome() { return null }\n");
    const { renderFile } = await import("../../src/lib/react.js");
    const rendered = await renderFile(file);
    expect(rendered.html).toBe("<p>Ada</p>");
  });

  it("bundles once for several renders and removes its temporary directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dispatch-react-file-"));
    dirs.push(dir);
    const file = join(dir, "welcome.tsx");
    await writeFile(file, "export default function Welcome() { return null }\n");
    const { loadFile } = await import("../../src/lib/react.js");
    const loaded = await loadFile(file);
    expect(await loaded.render({ name: "{{{NAME}}}" })).toBe("<p>{{{NAME}}}</p>");
    expect(await loaded.render()).toBe("<p>Ada</p>");
    expect(builds).toHaveLength(1);
    expect(existsSync(builds[0]!.outfile)).toBe(false);
    expect(loaded.brand).toBe(true);
    expect(loaded.track).toBeUndefined();
  });

  it("asks for react-email when the file's project does not have it", async () => {
    const { rendererFor, renderFile } = await import("../../src/lib/react.js");
    const { CliError } = await import("../../src/lib/errors.js");
    expect(
      rendererFor(() => {
        throw new Error("missing");
      }),
    ).toBeUndefined();
    expect(
      rendererFor((name) => {
        if (name !== "react-email") throw new Error("missing");
        return name;
      }),
    ).toBe("react-email");

    const dir = await mkdtemp(join(tmpdir(), "dispatch-react-file-"));
    dirs.push(dir);
    const file = join(dir, "welcome.tsx");
    await writeFile(file, "export default function Welcome() { return null }\n");
    const esbuild = await import("esbuild");
    vi.mocked(esbuild.build).mockImplementationOnce(async () => {
      throw new Error("Install `react-email` in your project to use --react-email.");
    });
    const error = await renderFile(file).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CliError);
    expect((error as Error).message).toContain("Install `react-email`");
    expect((error as Error).name).toBe("react_email_build_error");
  });
});
