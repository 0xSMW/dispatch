import { Command } from "@commander-js/extra-typings";
import { guard } from "../lib/actions.js";
import { resolve, store } from "../lib/config.js";
import { helpText } from "../lib/help.js";
import { output, renderRecord } from "../lib/output.js";

export function mask(key: string) {
  return key.length <= 12 ? `${key.slice(0, 3)}…` : `${key.slice(0, 7)}…${key.slice(-4)}`;
}

// Reads the credentials file and the environment. Makes no network call.
export const whoami = new Command("whoami")
  .description("Show which API URL, key, and profile commands will use")
  .addHelpText(
    "after",
    helpText({
      output: '{"profile":"default","api_url":"http://localhost:3100","api_key":"sk_loca…_key","scope":"full","source":"profile"}',
      codes: ["profile_not_found"],
      examples: ["dispatch whoami", "dispatch whoami -p prod --json"],
    }),
  )
  .action(async (_options, command) => {
    await guard(command, "auth_error", async (globals) => {
      const resolved = resolve(globals);
      const saved = resolved.profile ? store.read().profiles[resolved.profile] : undefined;
      const info = {
        profile: resolved.profile ?? null,
        api_url: resolved.apiUrl,
        api_key: mask(resolved.apiKey),
        scope: resolved.source === "profile" ? (saved?.scope ?? null) : null,
        source: resolved.source,
      };
      output(info, globals, () => renderRecord(info));
    });
  });
