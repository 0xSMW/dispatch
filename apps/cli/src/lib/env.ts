// Loads `.env` before anything reads the environment. Import it for its effect, first.
//
// The working directory's file, then the workspace root's. The CLI is usually started with
// `pnpm --filter @dispatchmail/cli start`, which runs it inside apps/cli, so without the second file
// the repo's own `.env` was never read. A variable already set is never replaced.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { config } from "dotenv";
import { workspaceRoot } from "../commands/dev/run.js";

for (const dir of new Set([process.cwd(), workspaceRoot()])) {
  const path = join(dir, ".env");
  if (existsSync(path)) config({ path, quiet: true } as Parameters<typeof config>[0]);
}
