import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { keyHash } from "../packages/core/src/crypto.js";
import { connect } from "../packages/db/src/index.js";
import { access } from "./usage/access.js";
import { audience } from "./usage/audience.js";
import { send } from "./usage/send.js";
import type { Receipt, Usage } from "./usage/common.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const execute = promisify(execFile);
const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required; use an explicit disposable home-server environment`);
  return value;
};
const check = (value: unknown, message: string) => { if (!value) throw new Error(message); };
const privateField = /^(password(?:_hash)?|token|secret|signing_secret|authorization|api_key|app_secret|api_key_pepper|cookie|set-cookie)$/i;
function redact(value: any): any {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, privateField.test(key) ? "[redacted]" : redact(item)]));
  return typeof value === "string" ? value.replace(/\bsk_[\w-]+/g, "[redacted]").replace(/([?&]token=)[^&\s]+/g, "$1[redacted]") : value;
}

async function main() {
  const database = required("USAGE_DATABASE_URL"), suppliedUrl = required("DISPATCH_API_URL"), key = required("DISPATCH_API_KEY");
  const tenant = required("USAGE_TENANT_ID"), sender = required("USAGE_SENDER"), pepper = required("API_KEY_PEPPER");
  const restartWorker = required("USAGE_RESTART_WORKER");
  check(isAbsolute(restartWorker), "Worker restart launcher must be an explicit absolute path for the disposable environment");
  const apiTarget = new URL(suppliedUrl), dbTarget = new URL(database), url = apiTarget.origin;
  check(process.env.SES_PROVIDER === "fake" && process.env.AWS_REGION === "us-west-2", "Usage requires the fake provider in us-west-2");
  check(["127.0.0.1", "localhost", "[::1]"].includes(apiTarget.hostname) && apiTarget.protocol === "http:", "Usage API must be explicit loopback HTTP");
  check(!apiTarget.username && !apiTarget.password && apiTarget.pathname === "/" && !apiTarget.search && !apiTarget.hash, "Usage API must be a bare origin without credentials");
  check(["127.0.0.1", "localhost", "[::1]"].includes(dbTarget.hostname) && ["postgres:", "postgresql:"].includes(dbTarget.protocol), "Usage database must be explicit loopback Postgres");
  check(database === process.env.DATABASE_URL, "Usage and product database targets must match exactly");
  const run = `usage-${Date.now()}-${randomBytes(4).toString("hex")}`;
  const dir = resolve(process.env.USAGE_EVIDENCE_DIR ?? join(root, ".dispatch", "usage"), run);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const record = async (kind: string, data: unknown) => appendFile(join(dir, "commands.jsonl"), JSON.stringify({ at: new Date().toISOString(), kind, data: redact(data) }) + "\n", { mode: 0o600 });
  const command: Usage["command"] = async (program, args, options = {}) => {
    const safeArgs = args.map((value, i) => ["--api-key", "--password"].includes(args[i - 1] ?? "") ? "[redacted]" : value);
    try {
      const result = await execute(program, args, { cwd: options.cwd ?? root, env: { ...process.env, ...options.env }, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
      await record("command", { program, args: safeArgs, exit: 0, stdout: result.stdout, stderr: result.stderr });
      return result.stdout;
    } catch (error: any) {
      await record("command", { program, args: safeArgs, exit: error.code, stdout: error.stdout, stderr: error.stderr });
      throw new Error(`${program} failed; inspect the private command receipt`);
    }
  };
  const request = async (method: string, path: string, body: unknown, status: number, token: string, headers: Record<string, string>, form?: Record<string, string>) => {
    check(path.startsWith("/") && !path.startsWith("//") && !path.includes("://"), "Requests must stay on the fixture API");
    const args = ["--silent", "--show-error", "--max-time", "20", "-X", method, `${url}${path}`, "-w", "\n%{http_code}"];
    if (token) args.push("-H", `Authorization: Bearer ${token}`);
    for (const [name, value] of Object.entries(headers)) args.push("-H", `${name}: ${value}`);
    if (form) for (const [name, value] of Object.entries(form)) args.push("-F", `${name}=${value}`);
    else if (body !== undefined || method === "DELETE") args.push("-H", "Content-Type: application/json", "--data-binary", JSON.stringify(body ?? {}));
    let result;
    try { result = await execute("curl", args, { timeout: 25_000, maxBuffer: 4 * 1024 * 1024 }); }
    catch (error: any) {
      await record("transport", { method, path, exit: error.code, stderr: error.stderr });
      throw new Error(`${method} ${path}: curl transport failed; inspect the private receipt`);
    }
    const split = result.stdout.lastIndexOf("\n"), actual = Number(result.stdout.slice(split + 1));
    const data = JSON.parse(result.stdout.slice(0, split));
    await record("http", { method, path, body, form, status: actual, expected: status, response: data });
    check(actual === status, `${method} ${path}: expected ${status}, received ${actual} (${data.name ?? "response"})`);
    return data;
  };
  const observationTarget = new URL(database);
  observationTarget.searchParams.set("options", "-c default_transaction_read_only=on");
  const db = connect(observationTarget.toString());
  const receipts: Receipt[] = [], cleanup: string[] = [];
  const receiver = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", chunk => chunks.push(chunk));
    request.on("end", () => { receipts.push({ raw: Buffer.concat(chunks).toString(), headers: request.headers }); response.writeHead(200).end("ok"); });
  });
  const started = Date.now(), gates: { name: string; result: string; ms: number }[] = [];
  const source = process.env.USAGE_SOURCE_SHA ?? "working-tree";
  let passed = false;
  try {
    check((await db.query("select current_setting('transaction_read_only') as readonly")).rows[0].readonly === "on", "Observer database connection must be read-only");
    const owner = (await db.query("select tenant_id from api_keys where hash=$1 and revoked_at is null", [keyHash(key, pepper)])).rows;
    check(owner.length === 1 && owner[0].tenant_id === tenant, "API credential must belong to the explicitly selected fixture tenant/database");
    const domain = sender.slice(sender.lastIndexOf("@") + 1);
    check((await db.query("select id from domains where tenant_id=$1 and name=$2 and status='verified' and deleted_at is null", [tenant, domain])).rowCount === 1, "Fixture sender domain must be verified");
    await new Promise<void>(resolve => receiver.listen(0, "127.0.0.1", resolve));
    const address = receiver.address();
    check(address && typeof address === "object", "Local receiver must listen");
    const u: Usage = {
      run, dir, url, key, tenant, sender, hook: { url: `http://127.0.0.1:${(address as any).port}/receipt`, receipts }, check, command,
      api: (method, path, body, status = 200, token = key, headers = {}) => request(method, path, body, status, token, headers),
      form: (path, fields, status = 200) => request("POST", path, undefined, status, key, {}, fields),
      sql: async (query, values = []) => {
        check(/^\s*select\b/i.test(query), "Usage SQL is read-only observation");
        const rows = (await db.query(query, values)).rows;
        await record("sql", { query, values, rows });
        return rows;
      },
      wait: async (read, done, label) => {
        const until = Date.now() + 30_000;
        do { const value = await read(); if (done(value)) return value; await new Promise(resolve => setTimeout(resolve, 250)); } while (Date.now() < until);
        throw new Error(`Timed out waiting for ${label}`);
      },
      clean: path => cleanup.push(path),
      restart: async () => { await command(restartWorker, []); },
    };
    check((await u.api("GET", "/health")).provider === "fake", "Running API must report fake provider");
    check((await u.api("GET", "/setup")).tenant.id === tenant, "Running API and observed database must identify the same tenant");
    const guardStart = Date.now();
    const output = await command("pnpm", ["test"]);
    check(/# tests 2\b/.test(output) && /# pass 2\b/.test(output) && /# fail 0\b/.test(output), "Exactly two guard cases must execute and pass");
    gates.push({ name: "credentials", result: "passed", ms: Date.now() - guardStart }, { name: "connections", result: "passed", ms: 0 });
    for (const [name, journey] of [["sending", send], ["audience", audience], ["access", access]] as const) {
      const at = Date.now();
      await journey(u);
      gates.push({ name, result: "passed", ms: Date.now() - at });
      console.log(`${name}: passed`);
    }
    for (const path of cleanup.reverse()) {
      const response = await request("DELETE", path, {}, 200, key, {}).catch(async error => {
        if (String(error.message).includes("received 404")) return null;
        throw error;
      });
      await record("cleanup", { path, result: response === null ? "already absent" : "completed", response });
    }
    passed = true;
  } catch (error) {
    await record("failure", { message: String(error), retainedFixtures: cleanup });
    for (const path of cleanup.filter(path => /^\/(webhooks|automations)\//.test(path)).reverse()) {
      await request("DELETE", path, {}, 200, key, {}).catch(cleanupError => record("cleanup-failure", { path, message: String(cleanupError) }));
    }
    throw error;
  } finally {
    const summary = { run, source, provider: "fake", result: passed ? "passed" : "failed", gates, duration_ms: Date.now() - started, webhook_receipts: receipts.length, evidence: dir };
    await writeFile(join(dir, "summary.json"), JSON.stringify(summary, null, 2) + "\n", { mode: 0o600 });
    await writeFile(join(dir, "webhooks.json"), JSON.stringify(receipts.map(row => ({ raw: row.raw, headers: redact(row.headers), payloadSha256: createHash("sha256").update(row.raw).digest("hex") })), null, 2), { mode: 0o600 });
    await new Promise<void>(resolve => receiver.close(() => resolve()));
    await db.end();
    console.log(JSON.stringify(summary));
  }
}

main().catch(error => { console.error(String(error.message)); process.exitCode = 1; });
