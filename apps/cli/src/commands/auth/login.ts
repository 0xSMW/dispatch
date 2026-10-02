import { Command } from "@commander-js/extra-typings";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { guard } from "../../lib/actions.js";
import { clientFor, unwrap } from "../../lib/client.js";
import { defaultUrl, setAside, store, type Credentials } from "../../lib/config.js";
import { CliError } from "../../lib/errors.js";
import { read } from "../../lib/files.js";
import { helpText } from "../../lib/help.js";
import { cancel, output } from "../../lib/output.js";
import { canPrompt, promptMissing } from "../../lib/prompts.js";
import { withSpinner } from "../../lib/spinner.js";

// Ask for the URL, then the key, check the pair with GET /me, and save it as a profile.
// A factory: login and logout sit both at the top level and under auth, and a
// Commander command can only have one parent.
export const login = () =>
  new Command("login")
    .description("Save an API URL and key as a profile")
    .option("--key <key>", "API key (or use --api-key)")
    .option("--name <profile>", 'Profile name (default: --profile, or "default")')
    .addHelpText(
      "after",
      helpText({
        output: '{"profile":"default","api_url":"http://localhost:3100","scope":"full"}',
        codes: ["missing_flags", "invalid_api_url", "auth_error"],
        examples: [
          "dispatch login",
          "dispatch login --api-url https://mail.example.com --key sk_... --name prod",
          "echo $KEY | dispatch login --api-url https://mail.example.com --key -",
        ],
      }),
    )
    .action(async (options, command) => {
      await guard(command, "auth_error", async (globals) => {
        const name = options.name ?? globals.profile ?? "default";
        let apiUrl = globals.apiUrl ?? process.env.DISPATCH_API_URL ?? process.env.DISPATCH_BASE_URL;
        if (!apiUrl && canPrompt(globals)) {
          const answer = await p.text({ message: "API URL", placeholder: defaultUrl, defaultValue: defaultUrl });
          if (p.isCancel(answer)) cancel();
          apiUrl = answer;
        }
        apiUrl = (apiUrl ?? defaultUrl).replace(/\/+$/, "");
        try {
          new URL(apiUrl);
        } catch {
          throw new CliError("invalid_api_url", `Invalid API URL: ${apiUrl}`);
        }
        let key = options.key ?? globals.apiKey;
        if (key === "-") key = (await read("-")).trim();
        const asked = await promptMissing({ key }, [{ key: "key", flag: "--key", label: "API key", secret: true }], globals);
        const me = await withSpinner(
          "Checking key...",
          () => unwrap<{ scope?: string }>(clientFor(asked.key, apiUrl).me.get()),
          globals,
        ).catch((error: Error) => {
          throw new CliError("auth_error", `That key did not work against ${apiUrl}: ${error.message}`);
        });
        // Login is the way out of a broken credentials file, so it must not fail on one.
        let credentials: Credentials;
        try {
          credentials = store.read();
        } catch (error) {
          if (!(error instanceof CliError) || error.code !== "credentials_error") throw error;
          console.error(`The credentials file could not be read. It was moved to ${setAside()} and a new one was started.`);
          credentials = { profiles: {} };
        }
        credentials.profiles[name] = { api_url: apiUrl, api_key: asked.key, ...(me.scope ? { scope: me.scope } : {}) };
        credentials.active_profile = name;
        store.write(credentials);
        output({ profile: name, api_url: apiUrl, scope: me.scope ?? null }, globals, () =>
          console.log(`${pc.green("✓")} Logged in to ${apiUrl} as profile ${pc.bold(name)}${me.scope ? ` (${me.scope})` : ""}`),
        );
      });
    });
