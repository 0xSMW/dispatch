import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const templates = fileURLToPath(new URL("..", import.meta.url));
const repo = fileURLToPath(new URL("../../..", import.meta.url));

// Corrupt disposable source copies, never the shared checkout or its committed artifact.
it.each([
  {
    name: "missing lifecycle default",
    file: "emails/setup-reminder.tsx",
    before: 'fallback_value: "there"',
    after: "fallback_value: null",
    error: "setup-reminder: required variable FIRST_NAME has no fallback or supplied value",
  },
  {
    name: "missing marketing unsubscribe link",
    file: "emails/_components/Layout.tsx",
    before: 'brand.unsubscribeUrl ?? "{{{UNSUBSCRIBE_URL}}}"',
    after: '"https://example.com/not-unsubscribe"',
    error: "newsletter-welcome check 16: missing UNSUBSCRIBE_URL link",
  },
  {
    name: "missing marketing company address",
    file: "emails/_components/Layout.tsx",
    before: "{brand.companyAddress}",
    after: "Address missing",
    error: "setup-reminder check 16: missing visible COMPANY_ADDRESS",
  },
  {
    name: "missing when guidance",
    file: "emails/setup-reminder.tsx",
    before: 'SetupReminder.When = "Send a few days after signup to contacts who have not activated. Stop the onboarding flow when they activate."',
    after: 'SetupReminder.When = ""',
    error: "setup-reminder check 17: missing when guidance",
  },
])("fails the actual build on $name and leaves the output untouched", ({ file, before, after, error }) => {
  // macOS aliases /var to /private/var. Match the imports' real paths for tsx's JSX config.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "dispatch-library-invalid-")));
  try {
    cpSync(join(templates, "emails"), join(dir, "emails"), { recursive: true });
    mkdirSync(join(dir, "src"));
    for (const file of ["build.ts", "check.ts", "types.ts"]) cpSync(join(templates, "src", file), join(dir, "src", file));
    mkdirSync(join(dir, "node_modules"));
    for (const name of ["react", "react-dom", "react-email"]) symlinkSync(join(templates, "node_modules", name), join(dir, "node_modules", name));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }));
    const tsconfig = join(dir, "tsconfig.json");
    writeFileSync(tsconfig, JSON.stringify({
      compilerOptions: {
        jsx: "react-jsx",
        module: "ESNext",
        moduleResolution: "bundler",
        paths: { "@dispatchmail/core": [join(repo, "packages/core/src/index.ts")] },
      },
    }));
    const source = join(dir, file);
    const original = readFileSync(source, "utf8");
    expect(original).toContain(before);
    writeFileSync(source, original.replace(before, after));
    const out = join(dir, "library.json");
    writeFileSync(out, "previous output");
    let failure: { status?: number; stderr?: Buffer; stdout?: Buffer } | undefined;
    try {
      execFileSync(join(repo, "node_modules/.bin/tsx"), ["--tsconfig", tsconfig, "src/build.ts"], {
        cwd: dir,
        env: { ...process.env, NODE_ENV: "production", LIBRARY_OUT: out },
        stdio: "pipe",
      });
    } catch (caught) {
      failure = caught as typeof failure;
    }
    expect(failure?.status).toBe(1);
    expect(String(failure?.stderr)).toContain("Template library checks failed");
    expect(String(failure?.stderr)).toContain(error);
    expect(existsSync(out)).toBe(true);
    expect(readFileSync(out, "utf8")).toBe("previous output");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);
