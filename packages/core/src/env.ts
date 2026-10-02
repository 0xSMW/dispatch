// Loads `.env` for a process started anywhere in the workspace. Import it for its effect, first:
//
//   import "@dispatchmail/core/env";
//
// `dotenv/config` reads only the working directory. Every process here starts through
// `pnpm --filter`, which runs it inside its own package folder, so the `.env` at the repo root
// was never read and every edit to it was ignored without a word.
//
// Order: a variable already in the environment wins, then the working directory's `.env`, then
// the workspace root's. dotenv never replaces a variable that is set.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { config } from "dotenv";

/** The folder that holds pnpm-workspace.yaml, or `start` when there is none above it. */
export function workspaceRoot(start = process.cwd()) {
  for (let dir = start; ; dir = dirname(dir)) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    if (dirname(dir) === dir) return start;
  }
}

export function loadEnv(cwd = process.cwd(), env: NodeJS.ProcessEnv = process.env) {
  const loaded: string[] = [];
  for (const dir of new Set([cwd, workspaceRoot(cwd)])) {
    const path = join(dir, ".env");
    if (!existsSync(path)) continue;
    config({ path, processEnv: env as Record<string, string>, quiet: true } as Parameters<typeof config>[0]);
    loaded.push(path);
  }
  return loaded;
}

loadEnv();
