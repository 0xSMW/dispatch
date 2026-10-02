import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, vi, type Mock } from "vitest";

// ---------------------------------------------------------------- SDK mock
// Use with: vi.mock("@dispatchmail/sdk", async () => (await import("../helpers.js")).sdk)
// Every property path on the client is a vi.fn, so method("domains.list") is the
// mock behind api.domains.list().

const methods = new Map<string, Mock>();
export const constructed: Array<Record<string, unknown>> = [];

export function method(path: string): Mock {
  let fn = methods.get(path);
  if (!fn) {
    fn = vi.fn(async () => ok({}));
    methods.set(path, fn);
  }
  return fn;
}

function node(path: string): unknown {
  return new Proxy(function () {}, {
    get(_target, prop) {
      if (typeof prop === "symbol" || prop === "then") return undefined;
      return node(path ? `${path}.${prop}` : prop);
    },
    apply(_target, _self, args) {
      return method(path)(...args);
    },
  });
}

class DispatchError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export const sdk = {
  Dispatch: class {
    constructor(options: Record<string, unknown>) {
      constructed.push(options);
      return node("") as object;
    }
  },
  DispatchError,
};

export function ok<T>(data: T, headers: Record<string, string> = {}) {
  return { data, error: null, headers };
}

export function err(name: string, statusCode: number | null, message = name, headers: Record<string, string> = {}) {
  return { data: null, error: { name, statusCode, message }, headers };
}

export function list<T>(data: T[], hasMore = false) {
  return ok({ object: "list", has_more: hasMore, data });
}

// ---------------------------------------------------------------- terminal

function tty(value: boolean) {
  for (const stream of [process.stdin, process.stdout, process.stderr]) {
    Object.defineProperty(stream, "isTTY", { value, configurable: true, writable: true });
  }
}

const saved = { ...process.env };
let configDir: string | undefined;

// Non-interactive, JSON output, an isolated config dir, and no keys from the shell.
export function setNonInteractive() {
  tty(false);
  for (const key of ["DISPATCH_API_KEY", "DISPATCH_API_URL", "DISPATCH_PROFILE", "API_URL", "APP_URL", "CI", "GITHUB_ACTIONS"]) {
    delete process.env[key];
  }
  configDir = mkdtempSync(join(tmpdir(), "dispatch-cli-test-"));
  process.env.XDG_CONFIG_HOME = configDir;
  return configDir;
}

export function setInteractive() {
  setNonInteractive();
  tty(true);
  process.env.TERM = "xterm-256color";
}

// ---------------------------------------------------------------- output

export function spies() {
  const out: string[] = [];
  const err: string[] = [];
  const text = (args: unknown[]) => args.map((arg) => (typeof arg === "string" ? arg : String(arg))).join(" ");
  vi.spyOn(console, "log").mockImplementation((...args) => void out.push(text(args)));
  vi.spyOn(console, "error").mockImplementation((...args) => void err.push(text(args)));
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  return { stdout: () => out.join("\n"), stderr: () => err.join("\n") };
}

export class Exit extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

// process.exit throws Exit, so a test can await the command and read the code.
export function captureExit() {
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Exit(code ?? 0);
  }) as never);
}

// Run a parse and return the exit code: 0 when the command returned normally.
export async function exitCode(work: Promise<unknown>) {
  try {
    await work;
    return 0;
  } catch (error) {
    if (error instanceof Exit) return error.code;
    throw error;
  }
}

// Parse a command the way a user would type it after the command's own name.
export async function run(command: { parseAsync(argv: string[], options: { from: "user" }): Promise<unknown> }, args: string[]) {
  return exitCode(command.parseAsync(args, { from: "user" }));
}

export function errorJson(stderr: string) {
  return JSON.parse(stderr) as { error: { message: string; code: string; statusCode?: number } };
}

afterEach(() => {
  vi.restoreAllMocks();
  methods.clear();
  constructed.length = 0;
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
  if (configDir) rmSync(configDir, { recursive: true, force: true });
  configDir = undefined;
});
