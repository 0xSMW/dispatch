import { spawn } from "node:child_process";
import type { CommandUnknownOpts } from "@commander-js/extra-typings";
import { guard } from "./actions.js";
import { isLocal, resolve } from "./config.js";
import { CliError } from "./errors.js";
import { output } from "./output.js";
import { interactive, type Globals } from "./tty.js";

// The dashboard's base URL: APP_URL, else the local Vite port for a local API. The API does not
// serve the dashboard, so a remote API with no APP_URL has no page to open.
export function appUrl(globals: Globals) {
  const configured = process.env.DISPATCH_APP_URL ?? process.env.APP_URL;
  if (configured) {
    let url: URL | undefined;
    try {
      url = new URL(configured);
    } catch {
      url = undefined;
    }
    if (!url || !["http:", "https:"].includes(url.protocol)) throw new CliError("invalid_app_url", `APP_URL is not an http or https URL: ${configured}`);
    return configured.replace(/\/+$/, "");
  }
  const { apiUrl } = resolve({ ...globals, apiKey: globals.apiKey ?? "unused" });
  if (isLocal(apiUrl)) return "http://localhost:5173";
  throw new CliError("missing_app_url", `Set DISPATCH_APP_URL to the dashboard's URL. ${apiUrl} is the API and does not serve it`);
}

export function launch(url: string) {
  const [bin, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? // Not `cmd /c start`, which reads &, |, and %VAR% in the URL as shell syntax.
          ["rundll32", ["url.dll,FileProtocolHandler", url]]
        : ["xdg-open", [url]];
  spawn(bin, args, { detached: true, stdio: "ignore" })
    .on("error", () => undefined)
    .unref();
}

// Print the URL, and open it in a browser when a person is at the terminal.
export async function openPath(command: CommandUnknownOpts, path: (globals: Globals) => Promise<string> | string) {
  await guard(command, "open_error", async (globals) => {
    const url = `${appUrl(globals)}${await path(globals)}`;
    const opened = interactive() && !globals.json && !globals.quiet;
    if (opened) launch(url);
    output({ url, opened }, globals, () => console.log(opened ? `Opened ${url}` : url));
  });
}
