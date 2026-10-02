import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { credentialsPath, devKey, resolve, store } from "../../src/lib/config.js";
import { setNonInteractive } from "../helpers.js";

const saved = (profiles: Record<string, { api_url: string; api_key: string; scope?: string }>, active?: string) =>
  store.write({ active_profile: active, profiles });

describe("resolve", () => {
  beforeEach(() => setNonInteractive());

  it("falls back to the local URL and the seeded dev key", () => {
    expect(resolve({})).toEqual({ apiKey: devKey, apiUrl: "http://localhost:3100", profile: undefined, source: "dev" });
  });

  it("only uses the dev key for localhost and 127.0.0.1", () => {
    expect(resolve({ apiUrl: "http://127.0.0.1:3100" }).source).toBe("dev");
    expect(() => resolve({ apiUrl: "https://mail.example.com" })).toThrowError(expect.objectContaining({ code: "auth_error" }));
  });

  it("orders key sources: flag, then env, then profile", () => {
    saved({ default: { api_url: "https://mail.example.com", api_key: "sk_profile" } }, "default");
    expect(resolve({}).apiKey).toBe("sk_profile");
    process.env.DISPATCH_API_KEY = "sk_env";
    expect(resolve({})).toMatchObject({ apiKey: "sk_env", source: "env" });
    expect(resolve({ apiKey: "sk_flag" })).toMatchObject({ apiKey: "sk_flag", source: "flag" });
  });

  it("orders URL sources for a key from a flag or the environment: flag, DISPATCH_API_URL, local API_URL, profile, default", () => {
    expect(resolve({ apiKey: "sk_flag" }).apiUrl).toBe("http://localhost:3100");
    saved({ default: { api_url: "https://profile.example.com", api_key: "sk_1" } }, "default");
    expect(resolve({ apiKey: "sk_flag" })).toMatchObject({ apiUrl: "https://profile.example.com", apiKey: "sk_flag", source: "flag" });
    process.env.API_URL = "http://localhost:4000";
    expect(resolve({ apiKey: "sk_flag" }).apiUrl).toBe("http://localhost:4000");
    process.env.DISPATCH_API_URL = "https://dispatch-url.example.com/";
    expect(resolve({ apiKey: "sk_flag" }).apiUrl).toBe("https://dispatch-url.example.com");
    expect(resolve({ apiKey: "sk_flag", apiUrl: "https://flag.example.com" }).apiUrl).toBe("https://flag.example.com");
  });

  it("never sends a saved key to a URL from the environment", () => {
    saved({ prod: { api_url: "https://mail.example.com", api_key: "sk_prod" } }, "prod");
    process.env.DISPATCH_API_URL = "https://api.other-app.example";
    expect(() => resolve({})).toThrowError(expect.objectContaining({ code: "auth_error" }));
    // An explicit profile is the pair that was saved, whatever the environment says.
    expect(resolve({ profile: "prod" })).toMatchObject({ apiKey: "sk_prod", apiUrl: "https://mail.example.com", source: "profile" });
    process.env.DISPATCH_API_KEY = "sk_env";
    expect(resolve({ profile: "prod" })).toMatchObject({ apiKey: "sk_prod", apiUrl: "https://mail.example.com" });
    expect(resolve({})).toMatchObject({ apiKey: "sk_env", apiUrl: "https://api.other-app.example", source: "env" });
  });

  it("ignores a generic API_URL that is not local", () => {
    saved({ prod: { api_url: "https://mail.example.com", api_key: "sk_prod" } }, "prod");
    process.env.API_URL = "https://api.other-app.example";
    expect(resolve({})).toMatchObject({ apiKey: "sk_prod", apiUrl: "https://mail.example.com" });
    process.env.DISPATCH_API_KEY = "sk_env";
    expect(resolve({}).apiUrl).toBe("https://mail.example.com");
  });

  it("refuses --api-url with --profile unless a key is given too", () => {
    saved({ prod: { api_url: "https://mail.example.com", api_key: "sk_prod" } }, "prod");
    expect(() => resolve({ profile: "prod", apiUrl: "https://elsewhere.example.com" })).toThrowError(expect.objectContaining({ code: "auth_error" }));
    expect(resolve({ profile: "prod", apiUrl: "https://mail.example.com/" }).apiKey).toBe("sk_prod");
    expect(resolve({ profile: "prod", apiUrl: "https://elsewhere.example.com", apiKey: "sk_flag" })).toMatchObject({
      apiKey: "sk_flag",
      apiUrl: "https://elsewhere.example.com",
    });
  });

  it("uses the dev key for a local URL when the saved profile is for another host", () => {
    saved({ prod: { api_url: "https://mail.example.com", api_key: "sk_prod" } }, "prod");
    expect(resolve({ apiUrl: "http://localhost:3100" })).toMatchObject({ source: "dev", apiUrl: "http://localhost:3100" });
  });

  it("does not read the credentials file when both the key and the URL are flags", () => {
    mkdirSync(dirname(credentialsPath()), { recursive: true });
    writeFileSync(credentialsPath(), '{"profiles": {"a": {"api_key": sk_live_secret}}}', { mode: 0o600 });
    expect(resolve({ apiKey: "sk_flag", apiUrl: "https://mail.example.com" }).apiKey).toBe("sk_flag");
    let message = "";
    try {
      resolve({});
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("not valid JSON");
    expect(message).not.toContain("sk_live");
  });

  it("picks the profile from --profile, then DISPATCH_PROFILE, then the active one", () => {
    saved(
      {
        a: { api_url: "https://a.example.com", api_key: "sk_a" },
        b: { api_url: "https://b.example.com", api_key: "sk_b" },
        c: { api_url: "https://c.example.com", api_key: "sk_c" },
      },
      "a",
    );
    expect(resolve({}).apiKey).toBe("sk_a");
    process.env.DISPATCH_PROFILE = "b";
    expect(resolve({})).toMatchObject({ apiKey: "sk_b", profile: "b" });
    expect(resolve({ profile: "c" })).toMatchObject({ apiKey: "sk_c", apiUrl: "https://c.example.com", profile: "c" });
  });

  it("fails on a named profile that does not exist", () => {
    expect(() => resolve({ profile: "nope" })).toThrowError(expect.objectContaining({ code: "profile_not_found" }));
  });

  it("fails on an invalid URL", () => {
    expect(() => resolve({ apiUrl: "not a url" })).toThrowError(expect.objectContaining({ code: "invalid_api_url" }));
  });
});

describe("credentials file", () => {
  beforeEach(() => setNonInteractive());

  it("lives under XDG_CONFIG_HOME/dispatch", () => {
    expect(credentialsPath()).toBe(`${process.env.XDG_CONFIG_HOME}/dispatch/credentials.json`);
  });

  it("reads as empty when missing", () => {
    expect(store.read()).toEqual({ active_profile: undefined, profiles: {} });
    expect(store.mode()).toBeNull();
  });

  it("writes with mode 0600, even over a looser existing file", () => {
    mkdirSync(dirname(credentialsPath()), { recursive: true });
    writeFileSync(credentialsPath(), "{}");
    chmodSync(credentialsPath(), 0o644);
    saved({ default: { api_url: "http://localhost:3100", api_key: "sk_1" } }, "default");
    expect(statSync(credentialsPath()).mode & 0o777).toBe(0o600);
    expect(store.mode()).toBe(0o600);
  });

  it("writes atomically through a temp file that is renamed away", () => {
    saved({ default: { api_url: "http://localhost:3100", api_key: "sk_1" } }, "default");
    saved({ prod: { api_url: "https://mail.example.com", api_key: "sk_2", scope: "send" } }, "prod");
    expect(readdirSync(dirname(credentialsPath()))).toEqual(["credentials.json"]);
    expect(JSON.parse(readFileSync(credentialsPath(), "utf8"))).toEqual({
      active_profile: "prod",
      profiles: { prod: { api_url: "https://mail.example.com", api_key: "sk_2", scope: "send" } },
    });
  });

  it("reports a corrupt file as credentials_error", () => {
    mkdirSync(dirname(credentialsPath()), { recursive: true });
    writeFileSync(credentialsPath(), "{nope");
    expect(() => store.read()).toThrowError(expect.objectContaining({ code: "credentials_error" }));
    expect(existsSync(credentialsPath())).toBe(true);
  });
});
