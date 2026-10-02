import { statSync } from "node:fs";
import { Command } from "@commander-js/extra-typings";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { auth } from "../../../src/commands/auth/index.js";
import { login } from "../../../src/commands/auth/login.js";
import { logout } from "../../../src/commands/auth/logout.js";
import { whoami } from "../../../src/commands/whoami.js";
import { credentialsPath, store } from "../../../src/lib/config.js";
import { captureExit, constructed, err, errorJson, method, ok, run, setNonInteractive, spies } from "../../helpers.js";

vi.mock("@dispatchmail/sdk", async () => (await import("../../helpers.js")).sdk);

// Global options live on the root, so mount the command under one.
function root(command: Command<any, any, any>) {
  return new Command("dispatch")
    .option("--api-key <key>")
    .option("--api-url <url>")
    .option("-p, --profile <name>")
    .option("--json")
    .addCommand(command);
}

const two = () =>
  store.write({
    active_profile: "default",
    profiles: {
      default: { api_url: "http://localhost:3100", api_key: "sk_local_1234567890", scope: "full" },
      prod: { api_url: "https://mail.example.com", api_key: "sk_prod_1234567890", scope: "send" },
    },
  });

describe("login", () => {
  beforeEach(() => {
    setNonInteractive();
    captureExit();
  });

  it("validates the pair with GET /me and saves the profile at mode 0600", async () => {
    method("me.get").mockResolvedValue(ok({ object: "me", scope: "send" }));
    const { stdout } = spies();
    expect(await run(root(login()), ["--api-url", "https://mail.example.com/", "-p", "prod", "login", "--key", "sk_prod"])).toBe(0);
    expect(constructed[0]).toMatchObject({ apiKey: "sk_prod", baseUrl: "https://mail.example.com" });
    expect(JSON.parse(stdout())).toEqual({ profile: "prod", api_url: "https://mail.example.com", scope: "send" });
    expect(store.read()).toEqual({
      active_profile: "prod",
      profiles: { prod: { api_url: "https://mail.example.com", api_key: "sk_prod", scope: "send" } },
    });
    expect(statSync(credentialsPath()).mode & 0o777).toBe(0o600);
  });

  it("does not save a key the API rejects", async () => {
    method("me.get").mockResolvedValue(err("invalid_api_key", 401, "API key is invalid"));
    const { stderr } = spies();
    expect(await run(root(login()), ["login", "--key", "sk_bad"])).toBe(1);
    expect(errorJson(stderr()).error.code).toBe("auth_error");
    expect(store.read().profiles).toEqual({});
  });

  it("needs --key without a terminal", async () => {
    const { stderr } = spies();
    expect(await run(root(login()), ["login"])).toBe(1);
    expect(errorJson(stderr()).error).toEqual({ code: "missing_flags", message: "Missing required flags: --key" });
  });
});

describe("logout and whoami", () => {
  beforeEach(() => {
    setNonInteractive();
    captureExit();
    two();
  });

  it("whoami reports the resolved profile without a network call and masks the key", async () => {
    const { stdout } = spies();
    await run(root(whoami), ["-p", "prod", "whoami"]);
    expect(JSON.parse(stdout())).toEqual({
      profile: "prod",
      api_url: "https://mail.example.com",
      api_key: "sk_prod…7890",
      scope: "send",
      source: "profile",
    });
    expect(constructed).toHaveLength(0);
  });

  it("logout removes the active profile and promotes another", async () => {
    const { stdout } = spies();
    await run(root(logout()), ["logout"]);
    expect(JSON.parse(stdout())).toEqual({ removed: ["default"], active_profile: "prod" });
    expect(Object.keys(store.read().profiles)).toEqual(["prod"]);
  });

  it("logout --all removes every profile", async () => {
    spies();
    await run(root(logout()), ["logout", "--all"]);
    expect(store.read()).toEqual({ active_profile: undefined, profiles: {} });
  });
});

describe("auth", () => {
  beforeEach(() => {
    setNonInteractive();
    captureExit();
    two();
  });

  it("lists profiles by default without keys", async () => {
    const { stdout } = spies();
    await run(root(auth), ["auth"]);
    const listed = JSON.parse(stdout());
    expect(listed.active_profile).toBe("default");
    expect(listed.profiles).toEqual([
      { name: "default", api_url: "http://localhost:3100", scope: "full", active: true },
      { name: "prod", api_url: "https://mail.example.com", scope: "send", active: false },
    ]);
    expect(stdout()).not.toContain("sk_");
  });

  it("switch, rename, and remove", async () => {
    spies();
    await run(root(auth), ["auth", "switch", "prod"]);
    expect(store.read().active_profile).toBe("prod");
    await run(root(auth), ["auth", "rename", "prod", "production"]);
    expect(store.read().active_profile).toBe("production");
    expect(Object.keys(store.read().profiles).sort()).toEqual(["default", "production"]);
    expect(await run(root(auth), ["auth", "remove", "production"])).toBe(1);
    expect(await run(root(auth), ["auth", "remove", "production", "--yes"])).toBe(0);
    expect(store.read()).toMatchObject({ active_profile: "default" });
  });

  it("fails clearly on unknown or clashing names", async () => {
    const { stderr } = spies();
    expect(await run(root(auth), ["auth", "switch", "nope"])).toBe(1);
    expect(errorJson(stderr()).error.code).toBe("profile_not_found");
    const second = spies();
    expect(await run(root(auth), ["auth", "rename", "default", "prod"])).toBe(1);
    expect(errorJson(second.stderr()).error.code).toBe("profile_exists");
    const third = spies();
    expect(await run(root(auth), ["auth", "switch"])).toBe(1);
    expect(errorJson(third.stderr()).error.code).toBe("missing_id");
  });
});
