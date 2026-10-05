import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import ts from "typescript";
import { Dispatch } from "../../packages/sdk/src/index.js";
import * as recipes from "./recipes.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const library = JSON.parse(readFileSync(resolve(root, "packages/templates/library.json"), "utf8"));
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

function offline(response: unknown = { id: "contact_123" }, status = 200) {
  const calls: Array<{ path: string; method: string; body: unknown }> = [];
  globalThis.fetch = vi.fn(async (url, init) => {
    calls.push({
      path: new URL(String(url)).pathname,
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return new Response(JSON.stringify(response), { status, headers: { "content-type": "application/json" } });
  });
  return { client: new Dispatch({ apiKey: "offline-example", baseUrl: "https://offline.invalid" }), calls };
}

const aggregate = {
  automation: { id: "auto_123", status: "disabled" },
  templates: { created: [{ id: "tpl_new", slug: "welcome" }], reused: [{ id: "tpl_edited", slug: "setup-reminder" }] },
  events: [], properties: [], next_steps: ["Review the automation and its emails", "Enable the automation"],
  request_id: "req_offline",
};

describe("offline lifecycle examples using the actual TypeScript SDK", () => {
  it.each(library.automations.map((p: { slug: string }) => p.slug))("installs %s disabled without automatically enabling", async (slug) => {
    const { client, calls } = offline(aggregate);
    const topic = slug === "failed-payment" ? undefined : "topic_123";
    const result = await recipes.install(client, slug, "Acme <hello@acme.com>", topic, "Reviewed copy");
    expect(result).toEqual(aggregate);
    expect(calls).toEqual([{
      path: `/template-library/automations/${slug}/install`, method: "POST",
      body: { from: "Acme <hello@acme.com>", name: "Reviewed copy", ...(topic ? { topic_id: topic } : {}) },
    }]);
  });

  it("reviews created and reused copies read-only, then enables only explicitly", async () => {
    const { client, calls } = offline({ id: "auto_123" });
    await recipes.review(client, "auto_123", ["tpl_new", "tpl_edited"]);
    expect(calls.map(c => [c.method, c.path])).toEqual([
      ["GET", "/automations/auto_123"], ["GET", "/templates/tpl_new"], ["GET", "/templates/tpl_edited"],
    ]);
    await recipes.enable(client, "auto_123");
    expect(calls.at(-1)).toEqual({ method: "PATCH", path: "/automations/auto_123", body: { status: "enabled" } });
  });

  it("creates consented subscriptions via a real off-to-on transition", async () => {
    const { client, calls } = offline();
    await recipes.subscribeNewsletter(client, "ada@example.com", "topic_123");
    expect(calls[0].body).toEqual({
      email: "ada@example.com", first_name: "Ada", properties: { activated: false },
      topics: [{ id: "topic_123", subscription: "opt_out" }],
    });
    expect(calls[1]).toEqual({ method: "PATCH", path: "/contacts/ada%40example.com/topics",
      body: { topics: [{ id: "topic_123", subscription: "opt_in" }] } });
  });

  it("writes new signup and activation as typed app-owned state", async () => {
    const { client, calls } = offline();
    await recipes.startOnboarding(client, "ada@example.com", "topic_123");
    await recipes.activate(client, "ada@example.com");
    expect(calls[0].body).toEqual({
      email: "ada@example.com", first_name: "Ada", properties: { activated: false },
      topics: [{ id: "topic_123", subscription: "opt_in" }],
    });
    expect(calls[1].body).toEqual({ properties: { activated: true } });
  });

  it("writes the plan before the limit event and updates after upgrade", async () => {
    const { client, calls } = offline();
    await recipes.reachLimit(client, "ada@example.com");
    await recipes.upgrade(client, "ada@example.com");
    expect(calls.map(c => c.body)).toEqual([
      { properties: { plan: "free" } },
      { event: "usage.limit_reached", email: "ada@example.com", payload: {} },
      { properties: { plan: "pro" } },
    ]);
  });

  it("preserves actual activity dates before firing inactivity", async () => {
    const { client, calls } = offline();
    await recipes.markInactive(client, "ada@example.com", "2026-09-01T10:00:00Z");
    await recipes.recordActivity(client, "ada@example.com", "2026-10-05T10:00:00Z");
    expect(calls.map(c => c.body)).toEqual([
      { properties: { last_active_at: "2026-09-01T10:00:00Z" } },
      { event: "user.inactive", email: "ada@example.com", payload: {} },
      { properties: { last_active_at: "2026-10-05T10:00:00Z" } },
    ]);
  });

  it("forwards caller invoice values and never cancels a subscription", async () => {
    const { client, calls } = offline();
    await recipes.paymentFailed(client, "ada@example.com", {
      amount: "EUR 57.40", updatePaymentUrl: "https://billing.example.test/customer/cus_42",
      number: "ACME-8042", id: "in_42",
    });
    await recipes.invoicePaid(client, "ada@example.com", "in_42");
    expect(calls.map(c => c.body)).toEqual([
      { event: "stripe.invoice.payment_failed", email: "ada@example.com", payload: {
        AMOUNT: "EUR 57.40", UPDATE_PAYMENT_URL: "https://billing.example.test/customer/cus_42",
        INVOICE_NUMBER: "ACME-8042", invoice_id: "in_42",
      } },
      { event: "stripe.invoice.paid", email: "ada@example.com", payload: { invoice_id: "in_42" } },
    ]);
    expect(calls.every(c => c.path === "/events/send")).toBe(true);
  });

  it("updates cancellation/reactivation truth without provider calls", async () => {
    const { client, calls } = offline();
    await recipes.cancelPlan(client, "ada@example.com");
    await recipes.restorePlan(client, "ada@example.com");
    expect(calls.map(c => c.body)).toEqual([{ properties: { plan: "canceled" } }, { properties: { plan: "pro" } }]);
    expect(calls.every(c => c.path === "/contacts/ada%40example.com")).toBe(true);
  });

  it("propagates SDK validation errors rather than claiming success", async () => {
    const { client, calls } = offline({ name: "validation_error", message: "Choose a topic", statusCode: 422 }, 422);
    await expect(recipes.install(client, "newsletter-welcome", "hello@acme.com")).rejects.toThrow("Choose a topic");
    expect(calls).toHaveLength(1);
  });

  it("does not fire a limit event when writing authoritative state fails", async () => {
    const { client, calls } = offline({ name: "not_found", message: "Contact not found", statusCode: 404 }, 404);
    await expect(recipes.reachLimit(client, "missing@example.com")).rejects.toThrow("Contact not found");
    expect(calls).toHaveLength(1);
  });
});

describe("public lifecycle recipe contracts", () => {
  it("typechecks every recipe's actual TypeScript blocks against SDK source without emitting files", () => {
    const options: ts.CompilerOptions = {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler, strict: true, skipLibCheck: true,
      noEmit: true, esModuleInterop: true,
    };
    const virtual = new Map<string, string>();
    for (const preset of library.automations) {
      const text = readFileSync(resolve(root, `docs/automations/${preset.slug}.md`), "utf8");
      const blocks = [...text.matchAll(/```ts\n([\s\S]*?)\n```/g)].map(match => match[1]);
      virtual.set(resolve(root, `examples/lifecycle/${preset.slug}.ts`),
        blocks.join("\n\n").replaceAll('"@dispatchmail/sdk"', '"../../packages/sdk/src/index.js"'));
    }
    const host = ts.createCompilerHost(options);
    const originalRead = host.readFile;
    const originalExists = host.fileExists;
    host.readFile = path => virtual.get(path) ?? originalRead(path);
    host.fileExists = path => virtual.has(path) || originalExists(path);
    host.getSourceFile = (path, languageVersion) => {
      const source = host.readFile(path);
      return source === undefined ? undefined : ts.createSourceFile(path, source, languageVersion, true);
    };
    const program = ts.createProgram([...virtual.keys()], options, host);
    const diagnostics = ts.getPreEmitDiagnostics(program);
    expect(diagnostics.map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))).toEqual([]);
  });

  it.each(library.automations)("documents $slug with the exact shipped graph and SDK producer", (preset) => {
    const text = readFileSync(resolve(root, `docs/automations/${preset.slug}.md`), "utf8");
    for (const heading of ["Goal", "App-owned state and events", "Trigger and re-entry",
      "Ordered graph and freshness", "Install, review, enable", "App calls", "Ask your agent"]) {
      expect(text).toContain(`## ${heading}`);
    }
    expect(text).toContain(`Re-entry: \`${preset.reentry}\``);
    const rows = text.split("\n").filter(line => /^\| `/.test(line));
    expect(rows).toHaveLength(preset.steps.length);
    preset.steps.forEach((step: { key: string; type: string; config: unknown }, index: number) => {
      expect(rows[index]).toContain(`| \`${step.key}\` | \`${step.type}\`: \`${JSON.stringify(step.config)}\``);
      const edges = preset.connections.filter((c: { from: string }) => c.from === step.key);
      for (const edge of edges) expect(rows[index]).toContain(`${edge.type} → \`${edge.to}\``);
      if (!edges.length) expect(rows[index]).toContain("| End |");
    });
    const source = readFileSync(resolve(root, "examples/lifecycle/recipes.ts"), "utf8");
    const appBlock = text.split("## App calls")[1].match(/```ts\n([\s\S]*?)\n```/)![1];
    for (const fn of appBlock.matchAll(/export async function [\s\S]*?^}/gm)) expect(source).toContain(fn[0]);
    expect(text).toContain("never overwritten");
    expect(text).toContain("scope following");
    expect(text).toContain(`--preset ${preset.slug}`);
  });

  it("copies current canonical agent prompts exactly at the end of each guide", () => {
    const reference = readFileSync(resolve(root, "apps/dashboard/src/lib/reference.ts"), "utf8");
    const suffix = reference.match(/prompt: `\$\{goals\[page.title\]\}([^`]+)`/)![1];
    const files = [
      ["docs/automations.md", "Automations"], ["docs/templates.md", "Templates"],
      ["docs/audience.md", "Contacts"], ["docs/domains.md", "Domains"], ["docs/cli.md", "Automations"],
      ["docs/automations/README.md", "Automations"],
      ...library.automations.map((p: { slug: string }) => [`docs/automations/${p.slug}.md`, "Automations"]),
    ];
    for (const [file, title] of files) {
      const goal = reference.match(new RegExp(`^  ${title}: "([^"]+)",$`, "m"))![1];
      expect(readFileSync(resolve(root, file), "utf8").trimEnd().endsWith(`\`\`\`text\n${goal}${suffix}\n\`\`\``)).toBe(true);
    }
  });

  it("resolves all authored public Markdown links and anchors", () => {
    const files = ["README.md", "docs/automations.md", "docs/templates.md", "docs/audience.md",
      "docs/domains.md", "docs/cli.md", "docs/automations/README.md", "examples/lifecycle/README.md",
      ...library.automations.map((p: { slug: string }) => `docs/automations/${p.slug}.md`)];
    for (const file of files) {
      const path = resolve(root, file);
      const text = readFileSync(path, "utf8").replace(/```[\s\S]*?```/g, "");
      for (const link of text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
        if (/^(https?:|mailto:)/.test(link[1])) continue;
        const [target, anchor] = link[1].split("#");
        const destination = target ? resolve(dirname(path), target) : path;
        expect(existsSync(destination), `${file}: ${link[1]}`).toBe(true);
        if (anchor) {
          const headings = [...readFileSync(destination, "utf8").matchAll(/^#+ (.+)$/gm)]
            .map(m => m[1].toLowerCase().replace(/[^\p{L}\p{N}_ -]/gu, "").replace(/ /g, "-"));
          expect(headings, `${file}: ${link[1]}`).toContain(anchor);
        }
      }
    }
  });
});
