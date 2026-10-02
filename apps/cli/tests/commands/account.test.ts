import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { dev } from "../../src/commands/dev/index.js";
import { runner, workspaceRoot } from "../../src/commands/dev/run.js";
import { open } from "../../src/commands/open.js";
import { system } from "../../src/commands/system.js";
import { timeline } from "../../src/commands/timeline.js";
import { usage } from "../../src/commands/usage.js";
import { captureExit, errorJson, list, method, ok, run, setNonInteractive, spies } from "../helpers.js";

vi.mock("@dispatchmail/sdk", async () => (await import("../helpers.js")).sdk);

describe("usage, system, timeline", () => {
  beforeEach(() => {
    setNonInteractive();
    captureExit();
  });

  it("read their single resources and the paged timeline", async () => {
    method("usage.get").mockResolvedValue(ok({ object: "usage" }));
    method("system.get").mockResolvedValue(ok({ object: "system" }));
    method("timeline.list").mockResolvedValue(list([]));
    const { stdout } = spies();
    await run(usage, []);
    await run(system, []);
    await run(timeline, ["--limit", "50"]);
    expect(method("timeline.list")).toHaveBeenCalledWith({ limit: 50 });
    expect(stdout()).toContain('"object": "usage"');
  });
});

describe("open", () => {
  beforeEach(() => {
    setNonInteractive();
    captureExit();
  });

  it("prints APP_URL plus the path when no one is at the terminal", async () => {
    process.env.APP_URL = "https://app.acme.com/";
    const { stdout } = spies();
    await run(open, ["domains"]);
    expect(JSON.parse(stdout())).toEqual({ url: "https://app.acme.com/domains", opened: false });
  });

  it("falls back to the local dashboard for a local API", async () => {
    const { stdout } = spies();
    await run(open, []);
    expect(JSON.parse(stdout()).url).toBe("http://localhost:5173/");
  });

  it("fails for a remote API with no APP_URL, since the API does not serve the dashboard", async () => {
    process.env.DISPATCH_API_URL = "https://mail.example.com";
    process.env.DISPATCH_API_KEY = "sk_1";
    const { stderr } = spies();
    expect(await run(open, [])).toBe(1);
    expect(errorJson(stderr()).error.code).toBe("missing_app_url");
  });

  it("refuses an APP_URL that is not http or https", async () => {
    process.env.APP_URL = "file:///etc/passwd";
    const { stderr } = spies();
    expect(await run(open, [])).toBe(1);
    expect(errorJson(stderr()).error.code).toBe("invalid_app_url");
  });
});

describe("dev", () => {
  beforeEach(() => {
    setNonInteractive();
    captureExit();
  });

  function child(code: number) {
    const emitter = new EventEmitter();
    setTimeout(() => emitter.emit("exit", code), 0);
    return emitter;
  }

  it("dev up runs docker compose and dev seed runs pnpm db:seed", async () => {
    const spawn = vi.spyOn(runner, "spawn").mockImplementation((() => child(0)) as never);
    spies();
    expect(await run(dev, ["up"])).toBe(0);
    // Run from the workspace root, with the child's stdout on stderr.
    const options = { stdio: ["inherit", 2, "inherit"], cwd: workspaceRoot() };
    expect(existsSync(join(options.cwd, "pnpm-workspace.yaml"))).toBe(true);
    expect(spawn).toHaveBeenLastCalledWith("docker", ["compose", "up", "-d"], options);
    expect(await run(dev, ["seed"])).toBe(0);
    expect(spawn).toHaveBeenLastCalledWith("pnpm", ["-w", "run", "db:seed"], options);
  });

  it("fails with dev_error on a non-zero exit", async () => {
    vi.spyOn(runner, "spawn").mockImplementation((() => child(2)) as never);
    const { stderr } = spies();
    expect(await run(dev, ["up"])).toBe(1);
    expect(errorJson(stderr()).error).toEqual({ code: "dev_error", message: "docker compose up -d exited 2" });
  });
});
