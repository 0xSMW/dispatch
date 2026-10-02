import { CliError } from "../../../lib/errors.js";
import { read } from "../../../lib/files.js";
import { many } from "../../../lib/json.js";

// Addresses from --emails, plus one per line (or a JSON array) from --file.
export async function addresses(flags: { emails?: string[]; file?: string }, flag = "--emails") {
  const out = many(flags.emails) ?? [];
  if (flags.file) {
    const text = (await read(flags.file)).trim();
    if (text.startsWith("[")) out.push(...(JSON.parse(text) as string[]));
    else
      out.push(
        ...text
          .split(/[\r\n,]+/)
          .map((line) => line.trim())
          .filter(Boolean),
      );
  }
  if (out.length === 0) throw new CliError("missing_flags", `Missing required flags: ${flag} or --file`);
  return out;
}
