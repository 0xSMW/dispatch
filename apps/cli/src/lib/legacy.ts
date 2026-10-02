// Old Dispatch command names, kept as hidden aliases for one release so
// existing scripts, docs, and shell history keep working.
export const aliases: Record<string, string[]> = {
  send: ["emails", "send"],
  batch: ["emails", "batch"],
  keys: ["api-keys"],
  received: ["emails", "receiving"],
  listen: ["webhooks", "listen"],
  replay: ["webhooks", "events", "replay"],
  "test-webhook": ["webhooks", "test"],
  "verify-domain": ["domains", "doctor"],
};

// Old subcommand names under groups that kept their name.
const nested: Record<string, Record<string, string[]>> = {
  webhooks: { attempts: ["events", "list"] },
  suppressions: { create: ["add"] },
  broadcasts: { clone: ["duplicate"] },
};

const valued = new Set(["--api-key", "--api-url", "-p", "--profile"]);

function firstOperand(argv: string[], from: number) {
  for (let index = from; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--") return -1;
    if (valued.has(arg)) {
      index += 1;
      continue;
    }
    if (!arg.startsWith("-")) return index;
  }
  return -1;
}

export function legacy(argv: string[]) {
  const out = [...argv];
  const at = firstOperand(out, 0);
  if (at === -1) return out;
  const replacement = aliases[out[at]!];
  if (replacement) out.splice(at, 1, ...replacement);
  const group = out[at]!;
  const next = firstOperand(out, at + 1);
  const renamed = next === -1 ? undefined : nested[group]?.[out[next]!];
  if (renamed && next === at + 1) out.splice(next, 1, ...renamed);
  return out;
}
