import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  Dispatch, type List, type Result, type SendEmailConfig, type SendKind,
  type SendOptions, type Template,
} from "./index.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

function stub(body: unknown) {
  const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } }));
  globalThis.fetch = fetch as typeof globalThis.fetch;
  return fetch;
}

describe("send kind contracts", () => {
  const configs: SendEmailConfig[] = [
    { template: "receipt", kind: "transactional" },
    { template: "newsletter", kind: "marketing", topic_id: "topic_1" },
    { template: "newsletter", kind: "marketing" },
    { template: "receipt" },
    { template: "newsletter", topic_id: "topic_1" },
  ];

  it.each(configs)("preserves explicit or omitted kinds in automation config %j", async (config) => {
    const fetch = stub({ id: "auto_1" });
    const client = new Dispatch({ apiKey: "sk_test" });
    const input = {
      name: "Typed", status: "disabled" as const,
      steps: [{ key: "send", type: "send_email", config }],
    };
    await client.automations.create(input);
    await client.automations.update("auto/1", input);
    await client.automations.dryRun("auto/1", input);
    for (const [, init] of fetch.mock.calls) {
      const body = JSON.parse(init!.body as string);
      expect(body).toEqual(input);
      expect(Object.hasOwn(body.steps[0].config, "kind")).toBe(Object.hasOwn(config, "kind"));
    }
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      "http://localhost:3100/automations",
      "http://localhost:3100/automations/auto%2F1",
      "http://localhost:3100/automations/auto%2F1?dry_run=true",
    ]);
    expectTypeOf<SendEmailConfig["kind"]>().toEqualTypeOf<SendKind | undefined>();
    expectTypeOf<SendKind>().toEqualTypeOf<"transactional" | "marketing">();
  });

  it("preserves normalized response configs without changing legacy requests", async () => {
    const steps = [
      { key: "receipt", type: "send_email", config: { template: "receipt", kind: "transactional" } },
      { key: "newsletter", type: "send_email", config: { template: "newsletter", kind: "marketing", topic_id: "topic_1" } },
    ];
    const fetch = stub({ id: "auto_1", steps });
    const client = new Dispatch({ apiKey: "sk_test" });
    const legacy = { name: "Legacy", steps: [{ key: "receipt", type: "send_email", config: { template: "receipt" } }] };
    expect((await client.automations.create(legacy)).data?.steps).toEqual(steps);
    expect(JSON.parse(fetch.mock.calls[0][1]!.body as string)).toEqual(legacy);
    expect((await client.automations.get("auto_1")).data?.steps).toEqual(steps);
  });

  it.each(["transactional", "marketing"] as const)("exposes %s template kinds on detail and list", async (kind) => {
    const template: Template = { object: "template", id: "template_1", kind, name: "Template" };
    stub(template);
    const client = new Dispatch({ apiKey: "sk_test" });
    const detail = await client.templates.get("template_1");
    expectTypeOf(detail).toEqualTypeOf<Result<Template>>();
    expectTypeOf(detail.data!.kind).toEqualTypeOf<SendKind>();
    expect(detail.data).toEqual(template);
    const listed: List<Template> = { object: "list", has_more: false, data: [template] };
    stub(listed);
    const list = await client.templates.list();
    expectTypeOf(list).toEqualTypeOf<Result<List<Template>>>();
    expect(list.data).toEqual(listed);
  });

  it("leaves ordinary send contracts keyed only by topic_id", async () => {
    expectTypeOf<SendOptions>().not.toHaveProperty("kind");
    const fetch = stub({ id: "email_1", sandbox: false });
    const client = new Dispatch({ apiKey: "sk_test" });
    const input = { from: "hello@acme.com", to: "alex@acme.com", subject: "Hello", text: "Hello" };
    await client.emails.send(input);
    await client.emails.send({ ...input, topicId: "topic_1" });
    expect(JSON.parse(fetch.mock.calls[0][1]!.body as string)).toEqual(input);
    expect(JSON.parse(fetch.mock.calls[1][1]!.body as string)).toEqual({ ...input, topic_id: "topic_1" });
  });
});
