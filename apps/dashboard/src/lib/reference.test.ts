import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Dispatch } from "../../../../packages/sdk/src/index";
import { curl, go, llmsLinks, python, referenceFor, references, sdk } from "./reference";

// The signed-in routes in main.tsx, read from the source so a new page cannot skip the reference.
const source = readFileSync(new URL("../main.tsx", import.meta.url), "utf8");
const publicPaths = new Set(["login", "shared", "unsubscribe", "confirm/:token", "*", "settings", "automations/events"]);
const routes = [...source.matchAll(/path: "([^"]+)"/g)].map((match) => match[1]!).filter((path) => !publicPaths.has(path));
const calls = Object.keys(references).flatMap((path) => referenceFor(path.replace(/:[a-z_]+/g, "resource_123"))!.calls);
const apiUrl = "https://api.acme.test";

afterEach(() => vi.unstubAllGlobals());

describe("API reference", () => {
  it("maps newly shipped reference expressions through the actual TypeScript client without network", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const dispatch = new Dispatch({ apiKey: "reference_test", baseUrl: apiUrl });
    const owned = calls.filter(call => /^\/forms(?:\/|\?|$)|\/segments\/preview|\/segments\/segment_123|\/steps\/split_123\/|\/goals\/goal_123\/metrics/.test(call.path));
    expect(owned).toHaveLength(13);
    for (const call of owned) {
      fetch.mockClear();
      await new Function("dispatch", `return ${call.sdk}`)(dispatch);
      expect(fetch, call.sdk!).toHaveBeenCalledOnce();
      const [url, init] = fetch.mock.calls[0]! as unknown as [string, RequestInit];
      expect(init.method, call.sdk!).toBe(call.method);
      expect(new URL(url).pathname, call.sdk!).toBe(call.path.split("?")[0]);
      expect([...new URL(url).searchParams].sort(), call.sdk!).toEqual([...new URL(`${apiUrl}${call.path}`).searchParams].sort());
      if (call.body) expect(JSON.parse(String(init.body)), call.sdk!).toEqual(call.body);
    }
  });

  it("covers new Forms, dynamic segments, goal reports and guarded split contracts", () => {
    const forms = references["/audience/forms"]!;
    expect(forms.prompt).toContain("never put an API key in the public form");
    const create = forms.calls.find(call => call.method === "POST")!;
    expect(sdk(create, apiUrl)).toContain("dispatch.forms.create(");
    expect(python(create, apiUrl)).toContain("client.create_form(");
    expect(go(create, apiUrl)).toContain("dispatch.FormInput{");
    const segments = references["/audience/segments"]!;
    expect(segments.prompt).toContain("dynamic membership is read-only");
    const preview = segments.calls.find(call => call.path === "/segments/preview")!;
    expect(preview.body).toEqual({ rule: { type: "rule", field: "contact.unsubscribed", operator: "eq", value: false } });
    expect(go(preview, apiUrl)).toContain('dispatch.Rule{Type: "rule"');
    const automation = referenceFor("/automations/flow_123/editor")!;
    const winner = automation.calls.find(call => call.path.endsWith("/winner"))!;
    expect(winner.summary).toContain("already paused");
    expect(python(winner, apiUrl)).toContain('client.pick_automation_winner("flow_123", "split_123", "variant_b", 1)');
    expect(go(winner, apiUrl)).toContain('client.PickAutomationWinner("flow_123", "split_123", "variant_b", 1)');
    expect(automation.calls.some(call => call.path === "/goals/goal_123/metrics?automation_id=flow_123")).toBe(true);
    expect(referenceFor("/broadcasts/broadcast_9")!.calls.some(call => call.path === "/goals/goal_123/metrics?broadcast_id=broadcast_9")).toBe(true);
    expect(references["/metrics"]!.calls.some(call => call.path === "/goals/goal_123/metrics")).toBe(true);
  });

  it("keeps newer public guide prompts equal to their canonical page prompts", () => {
    const guides = [
      ["goals.md", "/goals"], ["integrations.md", "/settings/integrations"],
      ["templates/theme.md", "/settings/brand"], ["settings.md", "/settings/general"],
      ["agent-tools.md", "/emails/send"],
    ];
    for (const [file, route] of guides) {
      const guide = readFileSync(new URL(`../../../../docs/${file}`, import.meta.url), "utf8");
      expect(guide.trimEnd().endsWith(`## Ask your agent\n\n\`\`\`text\n${references[route!]!.prompt}\n\`\`\``), file).toBe(true);
    }
  });
  it("exposes goals and explicit theme updates with three shipped client contracts", () => {
    const goals = referenceFor("/goals")!;
    expect(goals.prompt).not.toContain("undefined");
    const create = goals.calls.find((call) => call.method === "POST")!;
    expect(go(create, apiUrl)).toContain("dispatch.GoalInput{");
    expect(python(create, apiUrl)).toContain("client.create_goal(");
    const metrics = goals.calls.find((call) => call.path.includes("/metrics"))!;
    expect(python(metrics, apiUrl)).toContain("client.goal_metrics(");
    expect(go(metrics, apiUrl)).toContain("client.GoalMetrics(");
    const update = referenceFor("/settings/brand")!.calls.find((call) => call.path === "/brand/update-library")!;
    expect(sdk(update, apiUrl)).toContain("dispatch.brand.updateLibrary()");
    expect(python(update, apiUrl)).toContain("client.update_library_templates()");
    expect(go(update, apiUrl)).toContain("client.UpdateLibraryTemplates()");
  });
  it("uses shipped integrations client methods and a concrete credential-safe Agent prompt", () => {
    const reference = referenceFor("/settings/integrations")!;
    expect(reference.prompt).toMatch(/^Help me inspect Dispatch inbound integrations/);
    expect(reference.prompt).not.toContain("undefined");
    const create = reference.calls.find(call => call.method === "POST" && call.path === "/integrations")!;
    expect(python(create, apiUrl)).toContain("client.create_integration(");
    expect(go(create, apiUrl)).toContain("client.CreateIntegration(dispatch.IntegrationInput{");
    const history = reference.calls.find(call => call.path.includes("/deliveries"))!;
    expect(python(history, apiUrl)).toContain("client.integration_deliveries(");
    expect(go(history, apiUrl)).toContain("client.IntegrationDeliveries(");
  });
  it("covers every signed-in route", () => {
    expect(routes.length).toBeGreaterThan(30);
    expect(routes.filter((path) => !(`/${path}` in references))).toEqual([]);
  });

  it("uses concrete ids in every static Goals and Integrations example", () => {
    const goals = referenceFor("/goals")!;
    expect(goals.calls.map(({ method, path, sdk }) => ({ method, path, sdk }))).toEqual([
      { method: "GET", path: "/goals?limit=40", sdk: "dispatch.goals.list({ limit: 40 })" },
      { method: "POST", path: "/goals", sdk: 'dispatch.goals.create({ name: "Upgrade", target: { event: "upgraded" }, windowDays: 30 })' },
      { method: "GET", path: "/goals/goal_123", sdk: 'dispatch.goals.get("goal_123")' },
      { method: "PATCH", path: "/goals/goal_123", sdk: 'dispatch.goals.update("goal_123", { eligibility: null })' },
      { method: "DELETE", path: "/goals/goal_123", sdk: 'dispatch.goals.remove("goal_123")' },
      { method: "GET", path: "/goals/goal_123/metrics?broadcast_id=broadcast_123", sdk: 'dispatch.goals.metrics("goal_123", { broadcastId: "broadcast_123" })' },
    ]);
    const integrations = referenceFor("/settings/integrations")!;
    expect(integrations.calls.map(({ method, path, sdk }) => ({ method, path, sdk }))).toEqual([
      { method: "GET", path: "/integrations", sdk: "dispatch.integrations.list()" },
      { method: "POST", path: "/integrations", sdk: 'dispatch.integrations.create({ provider: "webhook", name: "App", secret: "SIGNING_SECRET" })' },
      { method: "GET", path: "/integrations/integration_123/deliveries?limit=20", sdk: 'dispatch.integrations.deliveries("integration_123", { limit: 20 })' },
      { method: "POST", path: "/integrations/integration_123/rotate", sdk: 'dispatch.integrations.rotate("integration_123")' },
    ]);
    for (const call of [...goals.calls, ...integrations.calls]) {
      for (const example of [call.path, call.sdk, curl(call, apiUrl), sdk(call, apiUrl), python(call, apiUrl), go(call, apiUrl)]) {
        expect(example).not.toBeNull();
        expect(example).not.toMatch(/:id|%(?:25)*3aid/i);
      }
    }
  });

  it("fills route params into paths and SDK calls", () => {
    const reference = referenceFor("/domains/domain_9")!;
    expect(reference.title).toBe("Domain");
    expect(reference.calls[0]).toMatchObject({ method: "GET", path: "/domains/domain_9", sdk: 'dispatch.domains.get("domain_9")' });
  });

  it("prefers a static route over a param route", () => {
    expect(referenceFor("/emails/receiving")!.title).toBe("Received emails");
    expect(referenceFor("/templates/library")!.title).toBe("Template library");
    expect(referenceFor("/emails/email_1")!.title).toBe("Email");
    expect(referenceFor("/nowhere")).toBeNull();
  });

  it("writes curl with the key from the environment and a JSON body", () => {
    const call = { method: "POST" as const, path: "/segments", summary: "", sdk: null, body: { name: "O'Brien" } };
    expect(curl(call, "https://api.acme.com")).toBe(
      [
        'curl -X POST "https://api.acme.com/segments" \\',
        '  -H "Authorization: Bearer $DISPATCH_API_KEY" \\',
        '  -H "Content-Type: application/json" \\',
        `  -d '{"name":"O'\\''Brien"}'`,
      ].join("\n"),
    );
    expect(sdk(call, "https://api.acme.com")).toBeNull();
    expect(sdk({ ...call, sdk: "dispatch.segments.list()" }, "https://api.acme.com")).toContain("await dispatch.segments.list();");
  });

  it("has canonical task-specific prompts for every signed-in page", () => {
    const prompts = new Set<string>();
    for (const reference of Object.values(references)) {
      expect(reference.prompt).toMatch(/^Help me /);
      expect(reference.prompt).not.toContain("undefined");
      expect(reference.prompt).toContain("only shipped endpoints and SDK methods");
      expect(reference.prompt).toContain("never print or embed the key");
      prompts.add(reference.prompt);
    }
    expect(prompts.size).toBe(Object.keys(references).length);
    expect(references["/emails/send"]!.prompt).toContain("without requiring contacts, topics, or automations");
  });

  it("only enables public llms links when their generated outputs exist", () => {
    expect(llmsLinks({}, "https://docs.acme.test/v1")).toEqual([]);
    expect(llmsLinks({ "../../../../docs/llms.txt": "Index", "../../../../docs/llms-full.txt": "" }, "https://docs.acme.test/v1/"))
      .toEqual([{ label: "llms.txt", href: "https://docs.acme.test/v1/llms.txt" }]);
    expect(llmsLinks({ "../../../../docs/llms.txt": "Index", "../../../../docs/llms-full.txt": "Full" }))
      .toHaveLength(2);
  });

  it("lists, previews and installs presets through the actual clients", () => {
    const library = references["/templates/library"]!;
    expect(library.calls.map((call) => call.path)).toContain("/template-library/automations");
    expect(library.calls.map((call) => call.path)).toContain("/template-library/automations/onboarding-drip");
    expect(calls.some((call) => /\/template-library\/automations\/.*\/install/.test(call.path))).toBe(true);
    const detail = library.calls.find((call) => call.path.endsWith("/onboarding-drip"))!;
    expect(python(detail, apiUrl)).toContain('client.template_library_automation("onboarding-drip")');
    expect(go(detail, apiUrl)).toContain('client.TemplateLibraryAutomation("onboarding-drip")');
    expect(referenceFor("/events")!.title).toBe("Events");
    expect(referenceFor("/automations/events")).toEqual(referenceFor("/events"));
  });

  it("runs every TypeScript example against the actual SDK and checks its request", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const dispatch = new Dispatch({ apiKey: "reference_test", baseUrl: apiUrl });
    for (const call of calls) {
      if (!call.sdk) continue;
      fetch.mockClear();
      await new Function("dispatch", `return ${call.sdk}`)(dispatch);
      expect(fetch, call.sdk).toHaveBeenCalledOnce();
      const [url, init] = fetch.mock.calls[0]! as unknown as [string, RequestInit];
      expect(init.method, call.sdk).toBe(call.method);
      expect(new URL(url).pathname, call.sdk).toBe(call.path.split("?")[0]);
      expect([...new URL(url).searchParams].sort(), call.sdk).toEqual([...new URL(`${apiUrl}${call.path}`).searchParams].sort());
      if (call.body) expect(JSON.parse(String(init.body)), call.sdk).toEqual(call.body);
    }
  });

  it("runs every supported Python snippet against the actual flat SDK with network calls mocked", () => {
    const examples = calls.map((call) => ({ call, code: python(call, apiUrl) })).filter((entry) => entry.code);
    const script = `
import json, os, sys
sys.path.insert(0, sys.argv[1])
from dispatch import Dispatch
os.environ["DISPATCH_API_KEY"] = "reference_test"
requests = []
def request(self, method, path, body=None, **kwargs):
    requests.append({"method": method, "path": path, "body": body})
    return {}
Dispatch._request = request
for code in json.load(sys.stdin):
    exec(compile(code, "<reference>", "exec"), {})
print(json.dumps(requests))
`;
    const result = spawnSync("python3", ["-B", "-c", script, fileURLToPath(new URL("../../../../packages/sdk-python", import.meta.url))], {
      input: JSON.stringify(examples.map((entry) => entry.code)), encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    const requests = JSON.parse(result.stdout) as Array<{ method: string; path: string; body: unknown }>;
    expect(requests).toHaveLength(examples.length);
    for (const [index, { call }] of examples.entries()) {
      const request = requests[index]!;
      expect(request.method).toBe(call.method);
      expect(request.path).toBe(call.path);
      if (call.body) expect(request.body).toMatchObject(call.body);
    }
  });

  it("uses actual Go method names and syntactically valid complete programs", () => {
    const client = ["client.go", "forms.go", "goals.go", "integrations.go"]
      .map(file => readFileSync(new URL(`../../../../packages/sdk-go/${file}`, import.meta.url), "utf8")).join("\n");
    for (const call of calls) {
      const code = go(call, apiUrl);
      if (!code) continue;
      const method = code.match(/data, err := client\.(\w+)\(/)![1]!;
      expect(client, method).toContain(`func (c *Client) ${method}(`);
      const parsed = spawnSync("gofmt", [], { input: code, encoding: "utf8" });
      expect(parsed.status, `${call.method} ${call.path}: ${parsed.stderr}`).toBe(0);
    }
  }, 20_000);

  it("keeps language-specific unsupported calls null instead of inventing methods", () => {
    const draft = referenceFor("/templates/tpl_1/editor")!.calls.find((call) => call.path.endsWith("/render"))!;
    expect(sdk(draft, apiUrl)).toContain('dispatch.templates.render("tpl_1", { NAME: "Ada" }, { draft: true })');
    expect(python(draft, apiUrl)).toBeNull();
    expect(go(draft, apiUrl)).toBeNull();
    const stats = references["/audience"]!.calls.find((call) => call.path === "/contacts/stats")!;
    expect(python(stats, apiUrl)).toBeNull();
    expect(go(stats, apiUrl)).toBeNull();
    const unknown = { method: "GET" as const, path: "/not-shipped", summary: "", sdk: null };
    expect(python(unknown, apiUrl)).toBeNull();
    expect(go(unknown, apiUrl)).toBeNull();
  });

  it("includes required Go positional arguments and language-specific booleans", () => {
    const send = references["/emails/send"]!.calls[0]!;
    expect(go(send, apiUrl)).toContain('}, "")');
    const settings = references["/settings/general"]!.calls[1]!;
    expect(python(settings, apiUrl)).toContain('{"import_trigger_automations": False}');
    expect(go(settings, apiUrl)).toContain('dispatch.Map{"import_trigger_automations": false}');
    const publish = referenceFor("/templates/tpl_9")!.calls.find((call) => call.path.endsWith("/publish"))!;
    expect(go(publish, apiUrl)).toContain('client.PublishTemplate("tpl_9", "")');
  });

  it("escapes resource ids and hosts instead of interpolating executable syntax", () => {
    const reference = referenceFor("/domains/a%22b")!;
    expect(reference.calls[0]!.path).toBe("/domains/a%22b");
    expect(reference.calls[0]!.sdk).toBe('dispatch.domains.get("a\\"b")');
    expect(python(reference.calls[0]!, apiUrl)).toContain('client.domain("a\\"b")');
    expect(go(reference.calls[0]!, apiUrl)).toContain('client.Domain("a\\"b")');
    expect(curl(reference.calls[0]!, "https://api.acme.test/$HOME")).toContain("\\$HOME");
    expect(sdk(reference.calls[0]!, 'https://api.acme.test/"')).toContain('baseUrl: "https://api.acme.test/\\""');
  });
});
