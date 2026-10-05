// Run: pnpm exec tsx scripts/llms.ts [--check] [--input docs/templates.md]
// Keep this explicit list limited to reviewed public guides. Git tracking alone
// does not make a plan, research document, or security report public.
import { execFileSync, spawnSync } from "node:child_process";
import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const publicDocs = [
  ...[
    ["README", "Lifecycle recipes"],
    ["newsletter-welcome", "Newsletter welcome"],
    ["onboarding-drip", "Onboarding drip"],
    ["invite-to-upgrade", "Invite to upgrade"],
    ["win-back", "Win back"],
    ["failed-payment", "Failed payment"],
    ["come-back", "Come back"],
  ].map(([slug, title]) => ({
    path: `docs/automations/${slug}.md`,
    title: title!,
    summary: "Goal, app-owned fields, exact graph, freshness and install/review/enable examples.",
  })),
  {
    path: "README.md",
    title: "Dispatch",
    summary:
      "Product overview, local quickstart, sending from code, and production setup.",
  },
  {
    path: "docs/api/README.md",
    title: "API",
    summary:
      "Authentication, permissions, response shapes, sending, and REST routes.",
  },
  {
    path: "docs/audience.md",
    title: "Audience",
    summary:
      "Contacts, typed properties, CSV imports, topics, and static segments.",
  },
  {
    path: "docs/automations.md",
    title: "Automations",
    summary:
      "Triggers, re-entry, email kinds, conditions, waits, and run controls.",
  },
  {
    path: "docs/aws.md",
    title: "AWS",
    summary: "AWS resources and permissions for SES, S3, and delivery queues.",
  },
  {
    path: "docs/cli.md",
    title: "CLI",
    summary: "CLI credentials, commands, flags, output, and errors.",
  },
  {
    path: "docs/deliverability/README.md",
    title: "Deliverability",
    summary:
      "Sender authentication, reputation, suppression, and delivery tracking.",
  },
  {
    path: "docs/domains.md",
    title: "Domains",
    summary:
      "Sending domain setup, DNS records, verification, and diagnostics.",
  },
  {
    path: "docs/local.md",
    title: "Local development",
    summary:
      "Local services, development fixtures, and the fake sending provider.",
  },
  {
    path: "docs/migration/README.md",
    title: "Migration",
    summary:
      "Moving an existing Resend integration to a self-hosted Dispatch instance.",
  },
  {
    path: "docs/operations/README.md",
    title: "Operations",
    summary:
      "Environment settings, background workers, storage, and service operations.",
  },
  {
    path: "docs/react-email.md",
    title: "React Email",
    summary: "Authoring, rendering, and publishing React Email templates.",
  },
  {
    path: "docs/self-hosting/README.md",
    title: "Self-hosting",
    summary:
      "Local and production deployment, required resources, and SES configuration.",
  },
  {
    path: "docs/settings.md",
    title: "Settings",
    summary: "Tenant defaults for imports and sandbox email domains.",
  },
  {
    path: "docs/smtp.md",
    title: "SMTP relay",
    summary:
      "SMTP authentication, transport configuration, and supported sending behavior.",
  },
  {
    path: "docs/templates.md",
    title: "Templates",
    summary:
      "Template publishing, variables, branding, and Transactional or Marketing kinds.",
  },
  {
    path: "docs/templates/README.md",
    title: "Template recipes",
    summary: "Email template integration recipes organized by provider.",
  },
  {
    path: "docs/templates/authjs.md",
    title: "Auth.js",
    summary: "Sending Auth.js authentication email through Dispatch.",
  },
  {
    path: "docs/templates/better-auth.md",
    title: "Better Auth",
    summary: "Sending Better Auth email with Dispatch templates.",
  },
  {
    path: "docs/templates/clerk.md",
    title: "Clerk",
    summary: "Using the SMTP relay for Clerk-rendered authentication email.",
  },
  {
    path: "docs/templates/stripe.md",
    title: "Stripe",
    summary: "Sending invoice and trial email from Stripe webhooks.",
  },
  {
    path: "docs/templates/supabase.md",
    title: "Supabase",
    summary: "Mapping Supabase Auth send-email hooks to Dispatch templates.",
  },
  {
    path: "docs/troubleshooting.md",
    title: "Troubleshooting",
    summary:
      "Diagnosing common setup, delivery, storage, and webhook failures.",
  },
  {
    path: "docs/webhooks.md",
    title: "Webhooks",
    summary:
      "Email and automation events, signature verification, retries, and replay.",
  },
] as const;

export const llmsOutputs = ["docs/llms.txt", "docs/llms-full.txt"] as const;

export interface PublicDoc {
  path: string;
  title: string;
  summary: string;
  content: string;
}

export interface LlmsOptions {
  root: string;
  inputs?: readonly string[];
  check?: boolean;
}

export interface LlmsResult {
  inputs: string[];
  outputs: string[];
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const normalize = (text: string) =>
  `${text.replace(/\r\n?/g, "\n").trimEnd()}\n`;
const outputLink = (path: string) => posix.relative("docs", path);

function git(root: string, args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
}

async function regularFile(root: string, path: string): Promise<void> {
  // Reject symlinked files and directories, including working-tree replacements
  // of tracked guides that would otherwise let an internal file enter the output.
  const parts = path.split("/");
  for (let index = 0; index < parts.length; index++) {
    const entry = await lstat(join(root, ...parts.slice(0, index + 1)));
    if (
      entry.isSymbolicLink() ||
      (index === parts.length - 1 ? !entry.isFile() : !entry.isDirectory())
    ) {
      throw new Error(`Expected a regular public document: ${path}`);
    }
  }
}

export async function loadPublicDocs(
  root: string,
  inputs?: readonly string[],
): Promise<PublicDoc[]> {
  root = await realpath(root);
  if (
    (await realpath(git(root, ["rev-parse", "--show-toplevel"]).trim())) !==
    root
  ) {
    throw new Error("The document root must be the Git repository root");
  }
  const tracked = new Set(
    git(root, ["ls-files", "--cached", "-z", "--", "README.md", "docs"])
      .split("\0")
      .filter(Boolean),
  );
  const allowed = new Map(publicDocs.map((doc) => [doc.path as string, doc]));
  const candidates =
    inputs === undefined
      ? publicDocs.map((doc) => doc.path)
      : [...new Set(inputs)];
  for (const path of candidates) {
    if (!allowed.has(path))
      throw new Error(`Not an approved public document: ${path}`);
    if (inputs !== undefined && !tracked.has(path))
      throw new Error(`Public document is untracked: ${path}`);
  }

  // --no-index also excludes accidentally tracked files that match local ignore
  // rules. Generated llms files and machine-readable artifacts are never inputs.
  const ignored = candidates.length
    ? spawnSync(
        "git",
        ["-C", root, "check-ignore", "--no-index", "-z", "--stdin"],
        {
          input: `${candidates.join("\0")}\0`,
          encoding: "utf8",
        },
      )
    : { status: 1, stdout: "", stderr: "", error: undefined };
  if (ignored.error) throw ignored.error;
  if (ignored.status !== 0 && ignored.status !== 1) {
    throw new Error(
      `Unable to check public document ignore rules: ${ignored.stderr.trim()}`,
    );
  }
  const excluded = new Set(ignored.stdout.split("\0").filter(Boolean));
  const selected = candidates
    .filter((path) => {
      if (inputs !== undefined && excluded.has(path))
        throw new Error(`Public document is ignored: ${path}`);
      return tracked.has(path) && !excluded.has(path);
    })
    .sort(compare);
  if (!selected.length)
    throw new Error("No tracked public documents were selected");

  return Promise.all(
    selected.map(async (path) => {
      await regularFile(root, path);
      return {
        ...allowed.get(path)!,
        content: normalize(await readFile(join(root, path), "utf8")),
      };
    }),
  );
}

function rebaseTarget(target: string, source: string): string {
  // Keep URLs, protocol-relative URLs, and site-root paths unchanged. Local
  // fragments point at the original guide, avoiding duplicate merged headings.
  if (/^(?:[a-z][a-z\d+.-]*:|\/)/i.test(target)) return target;
  const boundary = target.search(/[?#]/);
  const path = boundary < 0 ? target : target.slice(0, boundary);
  const suffix = boundary < 0 ? "" : target.slice(boundary);
  return `${outputLink(path ? posix.normalize(posix.join(posix.dirname(source), path)) : source)}${suffix}`;
}

function rebaseProse(line: string, source: string): string {
  const rewrite = (text: string) =>
    text.replace(
      /(!?\[[^\]\n]*\]\(\s*<?)([^\s<>]+?)(>?)(\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\)/g,
      (_, start: string, target: string, close: string, title: string = "") =>
        `${start}${rebaseTarget(target, source)}${close}${title})`,
    );
  // Leave inline code untouched, just as fenced code is left untouched below.
  let result = "";
  let cursor = 0;
  const runs = [...line.matchAll(/`+/g)];
  for (let index = 0; index < runs.length; index++) {
    const opening = runs[index]!;
    const closingIndex = runs.findIndex(
      (run, candidate) => candidate > index && run[0] === opening[0],
    );
    if (closingIndex < 0) continue;
    const closing = runs[closingIndex]!;
    result +=
      rewrite(line.slice(cursor, opening.index)) +
      line.slice(opening.index, closing.index + closing[0].length);
    cursor = closing.index + closing[0].length;
    index = closingIndex;
  }
  result += rewrite(line.slice(cursor));
  return result;
}

export function rebaseLinks(content: string, source: string): string {
  let fence: { marker: string; length: number } | undefined;
  return normalize(content)
    .split("\n")
    .map((line) => {
      const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (fence) {
        if (
          delimiter &&
          delimiter[1]![0] === fence.marker &&
          delimiter[1]!.length >= fence.length &&
          !delimiter[2]!.trim()
        ) {
          fence = undefined;
        }
        return line;
      }
      if (delimiter) {
        fence = { marker: delimiter[1]![0]!, length: delimiter[1]!.length };
        return line;
      }
      const reference = /^( {0,3}\[[^\]]+\]:\s*<?)([^\s<>]+)(>?)(.*)$/.exec(
        line,
      );
      if (reference)
        return `${reference[1]}${rebaseTarget(reference[2]!, source)}${reference[3]}${reference[4]}`;
      return rebaseProse(line, source);
    })
    .join("\n");
}

export function renderLlms(documents: readonly PublicDoc[]): {
  index: string;
  full: string;
} {
  const docs = [...documents].sort((a, b) => compare(a.path, b.path));
  const index = [
    "# Dispatch",
    "",
    "> Dispatch is a self-hosted, AWS-native email API and control plane built on Amazon SES.",
    "",
    "This index lists the tracked public guides selected by `scripts/llms.ts`.",
    "Links are relative to this file in `docs/`.",
    "",
    "## Documentation",
    "",
    ...docs.map(
      (doc) => `- [${doc.title}](${outputLink(doc.path)}): ${doc.summary}`,
    ),
    "",
    "## Full text",
    "",
    "- [Full documentation](llms-full.txt): The same public guides, including the API guide, in one file.",
    "",
  ].join("\n");
  const full = [
    "# Dispatch full documentation",
    "",
    "> The tracked public guides selected by `scripts/llms.ts`, including the API guide.",
    "",
    "[Documentation index](llms.txt)",
    "",
    ...docs.map((doc) =>
      [
        "---",
        "",
        `Source: [${doc.path}](${outputLink(doc.path)})`,
        "",
        rebaseLinks(doc.content, doc.path).trimEnd(),
        "",
      ].join("\n"),
    ),
    "",
  ].join("\n");
  return { index: normalize(index), full: normalize(full) };
}

export async function generateLlms(options: LlmsOptions): Promise<LlmsResult> {
  const documents = await loadPublicDocs(options.root, options.inputs);
  const { index, full } = renderLlms(documents);
  const outputs = llmsOutputs.map((path) => resolve(options.root, path));
  // Validate both destinations before any write. Never follow a replaced output
  // symlink or an ignored docs directory into another location.
  if (!(await lstat(join(options.root, "docs"))).isDirectory())
    throw new Error("Expected a regular docs directory");
  for (const path of llmsOutputs) {
    try {
      await regularFile(options.root, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const content = [index, full];
  if (options.check) {
    for (const [position, path] of outputs.entries()) {
      let existing: string | undefined;
      try {
        existing = await readFile(path, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (existing !== content[position])
        throw new Error(
          `Generated documentation is stale: ${llmsOutputs[position]}`,
        );
    }
  } else {
    for (const [position, path] of outputs.entries())
      await writeFile(path, content[position]!, "utf8");
  }
  return { inputs: documents.map((doc) => doc.path), outputs };
}

export async function main(args: readonly string[]): Promise<void> {
  let root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  let inputs: string[] | undefined;
  let check = false;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") {
      console.log(
        "Usage: pnpm exec tsx scripts/llms.ts [--check] [--root <repository>] [--input <public-path>]...",
      );
      console.log(
        "Without --input, selects tracked, non-ignored files from the explicit public guide allowlist.",
      );
      console.log(
        "--check verifies both generated files without writing. Paths for --input are repository-relative.",
      );
      return;
    }
    if (argument === "--check") check = true;
    else if (argument === "--root" || argument === "--input") {
      const value = args[++index];
      if (!value || value.startsWith("--"))
        throw new Error(`Missing value for ${argument}`);
      if (argument === "--root") root = resolve(value);
      else (inputs ??= []).push(value);
    } else throw new Error(`Unknown argument: ${argument}`);
  }
  const result = await generateLlms({ root, inputs, check });
  console.log(
    `${check ? "Checked" : "Generated"} ${result.outputs.length} files from ${result.inputs.length} tracked public documents:`,
  );
  for (const path of result.inputs) console.log(`  ${path}`);
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
