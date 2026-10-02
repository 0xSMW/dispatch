import * as p from "@clack/prompts";
import { store, type Credentials } from "../../lib/config.js";
import { CliError } from "../../lib/errors.js";
import { cancel } from "../../lib/output.js";
import { canPrompt } from "../../lib/prompts.js";
import type { Globals } from "../../lib/tty.js";

// A saved profile name, from the argument or a picker.
export async function pickProfile(name: string | undefined, globals: Globals, credentials: Credentials = store.read()) {
  if (name) {
    if (!credentials.profiles[name]) throw new CliError("profile_not_found", `Profile "${name}" not found`);
    return name;
  }
  const names = Object.keys(credentials.profiles);
  if (!canPrompt(globals)) throw new CliError("missing_id", "Missing profile name");
  if (!names.length) throw new CliError("profile_not_found", "No profiles saved. Run: dispatch login");
  const choice = await p.select({
    message: "Select a profile",
    options: names.map((value) => ({ value, label: value, hint: credentials.profiles[value]!.api_url })),
  });
  if (p.isCancel(choice)) cancel();
  return choice as string;
}
