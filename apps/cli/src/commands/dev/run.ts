import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { CliError } from "../../lib/errors.js";

export const runner = { spawn };

// The directory that holds pnpm-workspace.yaml. The CLI is often started through
// `pnpm --filter @dispatchmail/cli start`, which runs it inside apps/cli, where neither the root
// scripts nor docker-compose.yml are found.
export function workspaceRoot(start = process.cwd()) {
  for (let dir = start; ; dir = dirname(dir)) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    if (dirname(dir) === dir) return start;
  }
}

// Run a child process from the workspace root and fail on a non-zero exit. Its output goes to
// stderr, so stdout stays free for the command's own JSON.
export function run(command: string, args: string[]) {
  return new Promise<void>((done, reject) => {
    const child = runner.spawn(command, args, { stdio: ["inherit", 2, "inherit"], cwd: workspaceRoot() });
    child.on("error", (error) => reject(new CliError("dev_error", `${command}: ${error.message}`)));
    child.on("exit", (code) => (code === 0 ? done() : reject(new CliError("dev_error", `${command} ${args.join(" ")} exited ${code}`))));
  });
}
