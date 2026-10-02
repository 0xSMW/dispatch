import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CliError } from "./errors.js";
import type { Globals } from "./tty.js";

export const devKey = "sk_local_dispatch_dev_key_change_before_deploy";
export const defaultUrl = "http://localhost:3100";

export type Profile = { api_url: string; api_key: string; scope?: string };
export type Credentials = { active_profile?: string; profiles: Record<string, Profile> };

export function credentialsPath() {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "dispatch", "credentials.json");
}

// File storage today. A keychain backend can implement the same two methods later.
export const store = {
  read(): Credentials {
    try {
      const parsed = JSON.parse(readFileSync(credentialsPath(), "utf8")) as Partial<Credentials>;
      warnIfShared();
      return { active_profile: parsed.active_profile, profiles: parsed.profiles ?? {} };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { profiles: {} };
      // The parser's own message quotes the text around the error, which can be part of a key.
      const reason = error instanceof SyntaxError ? "it is not valid JSON" : ((error as NodeJS.ErrnoException).code ?? "it could not be opened");
      throw new CliError("credentials_error", `Could not read ${credentialsPath()}: ${reason}. Fix or delete the file, then run: dispatch login`);
    }
  },

  // Write to a temp file at mode 0600, then rename over the real file so a
  // crash never leaves a half-written or world-readable credentials file.
  write(credentials: Credentials) {
    const path = credentialsPath();
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      writeFileSync(temp, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
      chmodSync(temp, 0o600);
      renameSync(temp, path);
    } catch (error) {
      rmSync(temp, { force: true });
      throw error;
    }
  },

  mode(): number | null {
    try {
      return statSync(credentialsPath()).mode & 0o777;
    } catch {
      return null;
    }
  },
};

let warned = false;

// The file holds API keys. Other users on the machine should not be able to read it.
function warnIfShared() {
  if (warned || process.platform === "win32") return;
  const mode = store.mode();
  if (mode === null || !(mode & 0o077)) return;
  warned = true;
  console.error(`Warning: ${credentialsPath()} is readable by other users. Run: chmod 600 ${credentialsPath()}`);
}

// Move an unreadable credentials file aside so login can write a new one. Nothing is deleted.
export function setAside() {
  const path = credentialsPath();
  const backup = `${path}.unreadable`;
  renameSync(path, backup);
  chmodSync(backup, 0o600);
  return backup;
}

export function profileName(globals: Globals, credentials = store.read()) {
  return globals.profile ?? process.env.DISPATCH_PROFILE ?? credentials.active_profile ?? "default";
}

export function readProfile(name: string | undefined, credentials = store.read()): Profile | undefined {
  const key = name ?? credentials.active_profile ?? "default";
  return credentials.profiles[key];
}

export function isLocal(apiUrl: string) {
  return ["localhost", "127.0.0.1", "[::1]", "::1"].includes(new URL(apiUrl).hostname);
}

export type Resolved = {
  apiKey: string;
  apiUrl: string;
  profile?: string;
  source: "flag" | "env" | "profile" | "dev";
};

const clean = (url: string) => url.replace(/\/+$/, "");

function local(apiUrl: string) {
  try {
    return isLocal(apiUrl);
  } catch {
    throw new CliError("invalid_api_url", `Invalid API URL: ${apiUrl}`);
  }
}

// API_URL is a name many unrelated projects put in their .env, and the CLI loads .env from the
// working directory. It is only read when it names this machine, so running the CLI inside
// another project cannot point a key from the shell at that project's server.
function genericUrl() {
  const value = process.env.API_URL;
  if (!value) return undefined;
  try {
    return isLocal(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

// Which key goes to which URL.
//
// A saved profile is a pair: its key is only ever sent to its own URL. A URL from a flag, the
// environment, or a .env file in the working directory never picks up a saved key, because that
// would hand the key to whatever host that file names.
//
// 1. --profile (or DISPATCH_PROFILE) uses that profile's key and URL, and ignores the
//    environment. --api-key still overrides the key.
// 2. --api-key, then DISPATCH_API_KEY, go to the URL from --api-url, DISPATCH_API_URL, or a
//    local API_URL, then the active profile's URL, then localhost.
// 3. The active profile, unless a URL from a flag or the environment names another host.
// 4. The dev key, for a local API only.
export function resolve(globals: Globals): Resolved {
  // With both given on the command line the credentials file is not needed, so a broken file
  // cannot block the command.
  const explicit = globals.profile ?? process.env.DISPATCH_PROFILE;
  const credentials: Credentials = globals.apiKey && globals.apiUrl && !explicit ? { profiles: {} } : store.read();
  if (explicit && !credentials.profiles[explicit]) {
    throw new CliError("profile_not_found", `Profile "${explicit}" not found. Run: dispatch auth list`);
  }
  const name = explicit ?? credentials.active_profile;
  const saved = readProfile(name, credentials);
  const done = (apiKey: string, apiUrl: string, source: Resolved["source"], profile?: string): Resolved => {
    local(apiUrl);
    return { apiKey, apiUrl: clean(apiUrl), profile, source };
  };

  if (explicit && saved && !globals.apiKey) {
    if (globals.apiUrl && clean(globals.apiUrl) !== clean(saved.api_url)) {
      throw new CliError(
        "auth_error",
        `Profile "${explicit}" is saved for ${saved.api_url}. Its key is not sent to another URL. Pass --api-key as well, or drop --api-url`,
      );
    }
    return done(saved.api_key, saved.api_url, "profile", explicit);
  }

  // DISPATCH_BASE_URL is the name the SDKs use. Either works here.
  const elsewhere = globals.apiUrl ?? process.env.DISPATCH_API_URL ?? process.env.DISPATCH_BASE_URL ?? genericUrl();
  if (globals.apiKey) return done(globals.apiKey, elsewhere ?? saved?.api_url ?? defaultUrl, "flag", saved && !elsewhere ? (name ?? "default") : undefined);
  if (process.env.DISPATCH_API_KEY) {
    return done(process.env.DISPATCH_API_KEY, elsewhere ?? saved?.api_url ?? defaultUrl, "env", saved && !elsewhere ? (name ?? "default") : undefined);
  }
  if (saved && (!elsewhere || clean(elsewhere) === clean(saved.api_url))) {
    return done(saved.api_key, saved.api_url, "profile", name ?? "default");
  }
  const apiUrl = elsewhere ?? defaultUrl;
  if (local(apiUrl)) return done(devKey, apiUrl, "dev");
  throw new CliError(
    "auth_error",
    saved
      ? `No API key for ${clean(apiUrl)}. The saved profile is for ${saved.api_url}. Use --api-key, set DISPATCH_API_KEY, or run: dispatch login --api-url ${clean(apiUrl)}`
      : "No API key found. Set DISPATCH_API_KEY, use --api-key, or run: dispatch login",
  );
}
