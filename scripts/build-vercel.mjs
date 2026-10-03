import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync, lstatSync, unlinkSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";
const root = resolve(import.meta.dirname, "..");
execFileSync("pnpm", ["--filter", "@dispatchmail/dashboard", "build"], { cwd: root, stdio: "inherit", env: { ...process.env, VITE_API_URL: process.env.VITE_API_URL ?? "https://dispatch.smw.ai/api" } });
execFileSync("pnpm", ["exec", "nitro", "build"], { cwd: resolve(root, "apps/api"), stdio: "inherit", env: { ...process.env, NITRO_PRESET: "vercel" } });
const source = resolve(root, "apps/api/.vercel/output");
if (!existsSync(resolve(source, "config.json"))) throw new Error("Nitro did not produce Vercel output");
mkdirSync(resolve(root, ".vercel"), { recursive: true });
const destination = resolve(root, ".vercel/output");
if (!isAbsolute(destination) || relative(root, destination) !== ".vercel/output") throw new Error("Unexpected output path");
if (existsSync(destination)) rmSync(destination, { recursive: true });
cpSync(source, destination, { recursive: true, dereference: true });

// Nitro emits a symlink for the hook function; materialize it for portable CLI uploads.
const webhook = resolve(destination, "functions/.well-known/workflow/v1/webhook/[token].func");
if (lstatSync(webhook).isSymbolicLink()) {
  unlinkSync(webhook);
  cpSync(resolve(destination, "functions/__server.func"), webhook, { recursive: true, dereference: true });
}
const configuration = resolve(destination, "config.json");
const output = JSON.parse(readFileSync(configuration, "utf8"));
const seen = new Set();
output.routes = output.routes.filter(route => {
  const key = JSON.stringify(route);
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
});
output.crons = JSON.parse(readFileSync(resolve(root, "vercel.json"), "utf8")).crons ?? [];
writeFileSync(configuration, JSON.stringify(output, null, 2));
