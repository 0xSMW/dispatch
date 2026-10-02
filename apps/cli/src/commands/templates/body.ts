import { content, contentCommand, type ContentFlags } from "../../lib/content.js";
import { CliError } from "../../lib/errors.js";
import { collect, compact, many } from "../../lib/json.js";

const types = new Set(["string", "number", "list"]);

// "KEY:type:fallback", where type and fallback are optional.
export function variable(spec: string) {
  const [key, type = "string", ...rest] = spec.split(":");
  if (!key) throw new CliError("invalid_flag", `--var expects KEY:type:fallback, got "${spec}"`);
  if (!types.has(type)) throw new CliError("invalid_flag", `--var type must be string, number, or list, got "${type}"`);
  const fallback = rest.length ? rest.join(":") : undefined;
  const number = fallback === undefined || fallback.trim() === "" ? Number.NaN : Number(fallback);
  if (type === "number" && fallback !== undefined && !Number.isFinite(number)) {
    throw new CliError("invalid_flag", `--var ${key}: the fallback for a number must be a number, got "${fallback}"`);
  }
  return {
    key,
    type,
    fallback_value: fallback === undefined ? null : type === "number" ? number : fallback,
  };
}

export function templateCommand(name: string) {
  return contentCommand(name)
    .option("--subject <subject>", "Subject line, which may use {{{VARIABLES}}}")
    .option("--from <address>", "Default sender")
    .option("--reply-to <address>", "Default Reply-To. Repeatable", collect)
    .option("--var <KEY:type:fallback>", "Declare a variable. Repeatable", collect);
}

type Flags = ContentFlags & { subject?: string; from?: string; replyTo?: string[]; var?: string[]; variables?: string };

// The fields shared by create and update, with React Email's subject and variables as fallbacks.
export async function templateBody(flags: Flags) {
  const body = await content(flags, { stored: true });
  const declared = flags.var?.map(variable);
  const legacy = flags.variables?.split(",").filter(Boolean);
  const rendered = body.variables?.map((item) => ({
    key: item.key,
    type: item.type ?? "string",
    fallback_value: item.fallback_value ?? null,
  }));
  return compact({
    subject: flags.subject ?? body.subject,
    from: flags.from,
    replyTo: many(flags.replyTo),
    html: body.html,
    text: body.text,
    variables: declared ?? legacy ?? rendered,
    track: body.track,
  });
}
