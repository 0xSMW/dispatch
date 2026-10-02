import { execFile } from "node:child_process";
import { createConnection } from "node:net";
import { promisify } from "node:util";
import { Command } from "@commander-js/extra-typings";
import pc from "picocolors";
import { guard } from "../lib/actions.js";
import { clientFor, unwrap, version, type Api } from "../lib/client.js";
import { credentialsPath, isLocal, resolve, store, type Resolved } from "../lib/config.js";
import { helpText } from "../lib/help.js";
import { output } from "../lib/output.js";
import { safe } from "../lib/safe.js";
import { withSpinner } from "../lib/spinner.js";
import type { Globals } from "../lib/tty.js";

export type Check = { name: string; status: "pass" | "warn" | "fail"; message: string };

// Swappable in tests.
export const probes = {
  tcp(port: number) {
    return new Promise<string>((done, reject) => {
      const socket = createConnection({ host: "127.0.0.1", port, timeout: 1_000 });
      socket.on("connect", () => {
        socket.destroy();
        done("ready");
      });
      socket.on("timeout", () => {
        socket.destroy();
        reject(new Error(`port ${port} timed out`));
      });
      socket.on("error", reject);
    });
  },
  async docker() {
    const { stdout } = await promisify(execFile)("docker", ["compose", "ps", "--format", "json"], { cwd: process.cwd() });
    return stdout.trim() ? "services running" : "no services running";
  },
};

// `sendOnly` marks a check that reads something a sending-access key cannot. With such a key the
// refusal is expected, so it is a warning and not a failure.
async function check(name: string, run: () => Promise<string | void>, sendOnly = false): Promise<Check> {
  try {
    return { name, status: "pass", message: (await run()) || "ok" };
  } catch (error) {
    if (sendOnly) return { name, status: "warn", message: "Skipped: this key has sending access only" };
    return { name, status: "fail", message: error instanceof Error ? error.message : String(error) };
  }
}

function count(result: { data?: unknown[] }) {
  return `${result.data?.length ?? 0} found`;
}

export async function runChecks(globals: Globals): Promise<Check[]> {
  const checks: Check[] = [{ name: "cli", status: "pass", message: `dispatch-cli v${version} on Node ${process.versions.node}` }];

  let resolved: Resolved | undefined;
  try {
    resolved = resolve(globals);
    checks.push({
      name: "api key",
      status: resolved.source === "dev" ? "warn" : "pass",
      message:
        resolved.source === "dev"
          ? "Using the seeded local dev key. Run dispatch login to save your own"
          : `From ${resolved.source === "profile" ? `profile ${resolved.profile}` : resolved.source === "env" ? "DISPATCH_API_KEY" : "--api-key"}`,
    });
  } catch (error) {
    checks.push({ name: "api key", status: "fail", message: (error as Error).message });
  }

  const mode = store.mode();
  checks.push(
    mode === null
      ? { name: "credentials", status: "pass", message: `No credentials file at ${credentialsPath()}` }
      : mode & 0o077
        ? {
            name: "credentials",
            status: "fail",
            message: `${credentialsPath()} is readable by others (mode ${mode.toString(8)}). Run: chmod 600 ${credentialsPath()}`,
          }
        : { name: "credentials", status: "pass", message: `${credentialsPath()} (mode 600)` },
  );

  if (!resolved) return checks;
  const api: Api = clientFor(resolved.apiKey, resolved.apiUrl);
  let scope: string | undefined;
  checks.push(
    await check("api validation", async () => {
      const me = await unwrap<{ scope?: string }>(api.me.get());
      scope = me.scope;
      return `${resolved!.apiUrl} accepted the key${me.scope ? ` (scope ${me.scope})` : ""}`;
    }),
  );
  const limited = scope !== undefined && scope !== "full";

  if (isLocal(resolved.apiUrl)) {
    checks.push(await check("docker", () => probes.docker()));
    checks.push(await check("postgres", () => probes.tcp(5432)));
    checks.push(await check("redis", () => probes.tcp(6379)));
    checks.push(await check("mailpit", () => probes.tcp(8025)));
  }
  checks.push(await check("setup", async () => void (await unwrap(api.setup.get())), limited));
  checks.push(await check("health", async () => void (await unwrap(api.health()))));
  checks.push(await check("system", async () => void (await unwrap(api.system.get())), limited));
  checks.push(await check("domains", async () => count(await unwrap(api.domains.list({ limit: 100 }))), limited));
  checks.push(await check("emails", async () => count(await unwrap(api.emails.list({ limit: 10 }))), limited));
  checks.push(await check("webhooks", async () => count(await unwrap(api.webhooks.list({ limit: 100 }))), limited));
  return checks;
}

const marks = { pass: pc.green("✓"), warn: pc.yellow("!"), fail: pc.red("✗") };

export const doctor = new Command("doctor")
  .description("Check the CLI, your credentials, the API, and the local stack")
  .addHelpText(
    "after",
    helpText({
      output: '{"ok":true,"checks":[{"name":"api validation","status":"pass","message":"..."}]}',
      codes: ["doctor_error"],
      examples: ["dispatch doctor", "dispatch doctor --json | jq '.checks[] | select(.status != \"pass\")'"],
    }),
  )
  .action(async (_options, command) => {
    await guard(command, "doctor_error", async (globals) => {
      const checks = await withSpinner("Checking...", () => runChecks(globals), globals);
      const ok = checks.every((item) => item.status !== "fail");
      output({ ok, checks }, globals, () => {
        for (const item of checks) console.log(`${marks[item.status]} ${item.name.padEnd(15)} ${pc.dim(safe(item.message))}`);
      });
      if (!ok) process.exitCode = 1;
    });
  });
