import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { doctor, probes, runChecks } from "../../src/commands/doctor.js";
import { credentialsPath } from "../../src/lib/config.js";
import { captureExit, err, list, method, ok, run, setNonInteractive, spies } from "../helpers.js";

vi.mock("@dispatchmail/sdk", async () => (await import("../helpers.js")).sdk);

function healthy() {
  method("me.get").mockResolvedValue(ok({ scope: "full" }));
  for (const path of ["domains.list", "emails.list", "webhooks.list"]) method(path).mockResolvedValue(list([{ id: "x" }]));
  vi.spyOn(probes, "tcp").mockResolvedValue("ready");
  vi.spyOn(probes, "docker").mockResolvedValue("services running");
}

describe("doctor", () => {
  beforeEach(() => {
    setNonInteractive();
    captureExit();
  });

  it("runs the four CLI checks and the stack checks for a local API", async () => {
    healthy();
    const checks = await runChecks({});
    expect(checks.map((check) => check.name)).toEqual([
      "cli",
      "api key",
      "credentials",
      "api validation",
      "docker",
      "postgres",
      "redis",
      "mailpit",
      "setup",
      "health",
      "system",
      "domains",
      "emails",
      "webhooks",
    ]);
    expect(checks.find((check) => check.name === "api key")).toMatchObject({ status: "warn" });
    expect(checks.filter((check) => check.status === "fail")).toEqual([]);
  });

  it("skips the local stack checks for a remote API", async () => {
    healthy();
    const checks = await runChecks({ apiUrl: "https://mail.example.com", apiKey: "sk_1" });
    expect(checks.map((check) => check.name)).not.toContain("postgres");
    expect(checks.find((check) => check.name === "api key")).toMatchObject({ status: "pass", message: "From --api-key" });
  });

  it("prints { ok, checks } and exits 1 when a check fails", async () => {
    healthy();
    method("me.get").mockResolvedValue(err("invalid_api_key", 401, "API key is invalid"));
    const { stdout } = spies();
    await run(doctor, []);
    const report = JSON.parse(stdout());
    expect(report.ok).toBe(false);
    expect(report.checks.find((check: { name: string }) => check.name === "api validation")).toEqual({
      name: "api validation",
      status: "fail",
      message: "API key is invalid",
    });
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });

  it("warns, and does not fail, on what a sending-access key cannot read", async () => {
    process.env.DISPATCH_API_URL = "https://mail.example.com";
    process.env.DISPATCH_API_KEY = "sk_send";
    method("me.get").mockResolvedValue(ok({ scope: "send" }));
    method("health").mockResolvedValue(ok({ ok: true }));
    for (const name of ["setup.get", "system.get", "domains.list", "emails.list", "webhooks.list"]) {
      method(name).mockResolvedValue(err("restricted_api_key", 401, "Full access key required"));
    }
    const checks = await runChecks({});
    expect(checks.filter((item) => item.status === "fail")).toEqual([]);
    expect(checks.find((item) => item.name === "domains")).toEqual({ name: "domains", status: "warn", message: "Skipped: this key has sending access only" });
    expect(checks.find((item) => item.name === "health")?.status).toBe("pass");
  });

  it("fails the credentials check when the file is readable by others", async () => {
    healthy();
    mkdirSync(dirname(credentialsPath()), { recursive: true });
    writeFileSync(credentialsPath(), JSON.stringify({ profiles: {} }));
    chmodSync(credentialsPath(), 0o644);
    const checks = await runChecks({});
    expect(checks.find((check) => check.name === "credentials")).toMatchObject({ status: "fail" });
  });

  it("fails the api key check for a remote API with no key", async () => {
    const checks = await runChecks({ apiUrl: "https://mail.example.com" });
    expect(checks.find((check) => check.name === "api key")).toMatchObject({ status: "fail" });
    expect(checks.map((check) => check.name)).toEqual(["cli", "api key", "credentials"]);
  });
});
