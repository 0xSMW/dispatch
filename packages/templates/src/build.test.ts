import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import library from "../library.json";

const templates = fileURLToPath(new URL("..", import.meta.url));
const repo = fileURLToPath(new URL("../../..", import.meta.url));

// Corrupt disposable source copies, never the shared checkout or its committed artifact.
it.each([
  {
    name: "invalid preset graph",
    file: "src/presets.ts",
    before: 'edge("tips", "exit"), edge("setup", "exit"),',
    after: 'edge("tips", "exit"), edge("setup", "exit"), edge("exit", "trigger"),',
    error: "newsletter-welcome: Exit exit cannot have outgoing connections",
  },
  {
    name: "keyed preset graph missing its trigger",
    file: "src/presets.ts",
    before: '      step("trigger", "trigger", { type: "topic_subscribed", topic_id: installTopic }),\n',
    after: "",
    also: {
      before: '...chain("trigger", "freshness", "welcome", "wait", "activation"),',
      after: '...chain("freshness", "welcome", "wait", "activation"),',
    },
    error: "newsletter-welcome: An automation needs exactly one trigger step",
  },
  {
    name: "missing preset template",
    file: "src/presets.ts",
    before: 'send("welcome", "newsletter-welcome", "marketing")',
    after: 'send("welcome", "missing-template", "marketing")',
    error: "newsletter-welcome: welcome: unknown template missing-template",
  },
  {
    name: "missing required preset subject variable",
    file: "src/presets.ts",
    before: 'send("welcome", "newsletter-welcome", "marketing")',
    after: 'send("welcome", "newsletter-welcome", "marketing", "Hello {{{PREVIEW_ONLY}}}")',
    error: "newsletter-welcome: welcome: newsletter-welcome: required variable PREVIEW_ONLY has no fallback or supplied value",
  },
  {
    name: "required HTML and text body variable despite preview data",
    file: "emails/newsletter-welcome.tsx",
    before: 'fallback_value: "there"',
    after: "fallback_value: null",
    bodyVariable: { slug: "newsletter-welcome", key: "FIRST_NAME" },
    error: "newsletter-welcome: welcome: newsletter-welcome: required variable FIRST_NAME has no fallback or supplied value",
  },
  {
    name: "missing payment binding",
    file: "src/presets.ts",
    before: 'AMOUNT: "string", UPDATE_PAYMENT_URL: "string", INVOICE_NUMBER: "string", invoice_id: "string"',
    after: 'AMOUNT: "string", INVOICE_NUMBER: "string", invoice_id: "string"',
    error: "failed-payment: failed: payment-failed: required variable UPDATE_PAYMENT_URL has no fallback or supplied value",
  },
  {
    name: "missing actual payment value",
    file: "src/fixtures.ts",
    before: "return mapped.event.data;",
    after: "delete mapped.event.data.UPDATE_PAYMENT_URL;\n  return mapped.event.data;",
    error: "failed-payment: failed: payment-failed: required variable UPDATE_PAYMENT_URL has no fallback or supplied value",
  },
  {
    name: "wrong actual payment value type",
    file: "src/fixtures.ts",
    before: "return mapped.event.data;",
    after: "mapped.event.data.AMOUNT = 49;\n  return mapped.event.data;",
    error: "failed-payment: payload.AMOUNT must be a string",
  },
  {
    name: "transactional step with marketing template",
    file: "src/presets.ts",
    before: 'send("welcome", "newsletter-welcome", "marketing")',
    after: 'send("welcome", "newsletter-welcome", "transactional")',
    error: "newsletter-welcome: welcome: transactional step uses marketing template newsletter-welcome with incompatible send intent",
  },
  {
    name: "marketing step with transactional template",
    file: "src/presets.ts",
    before: 'send("welcome", "welcome", "transactional")',
    after: 'send("welcome", "welcome", "marketing")',
    error: "onboarding-drip: welcome: marketing step uses transactional template welcome with incompatible send intent",
  },
  {
    name: "missing following freshness guard",
    file: "src/presets.ts",
    before: 'return filter("freshness", rule(field, "within", window), "following");',
    after: 'return filter("freshness", rule(field, "within", window), "next");',
    error: "newsletter-welcome: Every send needs a following freshness filter: event.received_at within 7 days",
  },
  {
    name: "bypassed freshness guard",
    file: "src/presets.ts",
    before: '...chain("trigger", "freshness", "welcome", "wait", "activation"),',
    after: '...chain("trigger", "welcome", "wait", "activation"),',
    error: "newsletter-welcome: Every send needs a following freshness filter: event.received_at within 7 days",
  },
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
])("fails the actual build on $name and leaves the output untouched", ({ file, before, after, also, bodyVariable, error }) => {
  // macOS aliases /var to /private/var. Match the imports' real paths for tsx's JSX config.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dispatch-library-invalid-")));
  const dir = join(root, "packages/templates");
  try {
    mkdirSync(dir, { recursive: true });
    cpSync(join(templates, "emails"), join(dir, "emails"), { recursive: true });
    mkdirSync(join(dir, "src"));
    for (const file of ["build.ts", "check.ts", "types.ts", "presets.ts", "fixtures.ts"]) cpSync(join(templates, "src", file), join(dir, "src", file));
    // Reuse the pure adapter; only owned source copies are corrupted.
    symlinkSync(join(repo, "packages/db"), join(root, "packages/db"));
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
    let changed = original.replace(before, after);
    if (also) {
      expect(changed).toContain(also.before);
      changed = changed.replace(also.before, also.after);
    }
    if (bodyVariable) {
      const entry = library.templates.find((entry) => entry.slug === bodyVariable.slug)!;
      // The variable is used in both bodies, never the subject; a populated
      // preview is not evidence of actual trigger supply.
      expect(entry.subject).not.toContain(bodyVariable.key);
      expect(entry.html).toContain(`{{{${bodyVariable.key}|there}}}`);
      expect(entry.text).toContain(`{{{${bodyVariable.key}|there}}}`);
      expect(entry.sample).toMatchObject({ [bodyVariable.key]: "Ada" });
    }
    writeFileSync(source, changed);
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
    expect(String(failure?.stderr)).not.toContain("TypeError");
    expect(String(failure?.stderr)).not.toContain("Cannot read properties");
    expect(existsSync(out)).toBe(true);
    expect(readFileSync(out, "utf8")).toBe("previous output");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
