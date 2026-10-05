import assert from "node:assert/strict";
import { test } from "vitest";
import { callTool, tools, type ToolClient } from "./tools.js";

const names = [
  "send_email", "get_email", "list_emails", "send_event", "upsert_contact",
  "list_automations", "install_preset", "get_metrics", "list_templates", "render_template"
];
const reads = ["get_email", "list_emails", "list_automations", "get_metrics", "list_templates", "render_template"];

function fixture() {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const method = (name: string) => async (...args: unknown[]) => {
    calls.push({ method: name, args });
    return { data: { id: "result" }, error: null, headers: { authorization: "Bearer hidden", "set-cookie": "hidden" } };
  };
  const client = {
    emails: { send: method("emails.send"), get: method("emails.get"), list: method("emails.list"), metrics: method("emails.metrics") },
    events: { send: method("events.send") },
    contacts: { create: method("contacts.create") },
    automations: { list: method("automations.list") },
    templates: {
      list: method("templates.list"), render: method("templates.render"),
      library: { installAutomation: method("templates.library.installAutomation") }
    }
  } as unknown as ToolClient;
  return { client, calls };
}

test("registry publishes exactly ten tools and six read-only tools, with independent schemas", () => {
  assert.deepEqual(tools().map((tool) => tool.name), names);
  assert.deepEqual(tools(true).map((tool) => tool.name), reads);
  assert.ok(tools(true).every((tool) => tool.annotations.readOnlyHint));
  tools()[0].inputSchema.required!.push("notReal");
  assert.deepEqual(tools()[0].inputSchema.required, ["from", "to"]);
});

test("all ten tools call only shipped SDK methods and preserve camelCase payload/options", async () => {
  const { client, calls } = fixture();
  const send = {
    from: "App <app@example.com>", to: ["reader@example.com"], replyTo: "reply@example.com",
    template: { id: "welcome", variables: { firstName: "Ada" } },
    topicId: "topic", scheduledAt: "2026-10-05T00:00:00Z", idempotencyKey: "send-1",
    attachments: [{ filename: "a.txt", content: "YQ==", contentType: "text/plain" }]
  };
  const inputs = [
    send, { id: "email-1" }, { limit: 10, after: "cursor", q: "hello" },
    { contactId: "contact-1", event: "signed_up", payload: { plan: "pro" } },
    { email: "reader@example.com", firstName: "Ada", lastName: "Lovelace", properties: { plan: "pro" },
      topics: [{ id: "topic", subscription: "opt_in" }], segments: [{ id: "segment" }] },
    { limit: 5, before: "cursor", status: "paused" },
    { slug: "newsletter-welcome", from: "app@example.com", topicId: "topic", name: "Welcome" },
    { startDate: "2026-10-01", endDate: "2026-10-05", granularity: "daily",
      automationId: ["automation"], dimensions: ["automation_id"], metrics: ["sent"] },
    { status: "published", q: "Welcome", limit: 10 },
    { idOrAlias: "welcome", variables: { firstName: "Ada" }, draft: true }
  ];
  for (const [index, name] of names.entries()) {
    const result = await callTool(client, name, inputs[index]);
    assert.equal(result.isError, undefined);
    assert.deepEqual(JSON.parse(result.content[0].text), { id: "result" });
    assert.ok(!result.content[0].text.includes("hidden"));
  }
  const { idempotencyKey, ...payload } = send;
  assert.deepEqual(calls, [
    { method: "emails.send", args: [payload, { idempotencyKey }] },
    { method: "emails.get", args: ["email-1"] },
    { method: "emails.list", args: [inputs[2]] },
    { method: "events.send", args: [inputs[3]] },
    { method: "contacts.create", args: [inputs[4]] },
    { method: "automations.list", args: [inputs[5]] },
    { method: "templates.library.installAutomation", args: ["newsletter-welcome", { from: "app@example.com", topicId: "topic", name: "Welcome" }] },
    { method: "emails.metrics", args: [inputs[7]] },
    { method: "templates.list", args: [inputs[8]] },
    { method: "templates.render", args: ["welcome", { firstName: "Ada" }, { draft: true }] }
  ]);
});

test("read-only rejects every hidden write before invoking the SDK, with no argument escape hatch", async () => {
  const { client, calls } = fixture();
  for (const name of names.filter((name) => !reads.includes(name))) {
    const result = await callTool(client, name, { readOnly: false }, true);
    assert.equal(result.isError, true);
    assert.equal(JSON.parse(result.content[0].text).name, "read_only");
  }
  assert.equal((await callTool(client, "call", { method: "POST", path: "/emails" }, true)).isError, true);
  assert.deepEqual(calls, []);
  for (const name of reads) {
    const input = name === "get_email" ? { id: "email" } : name === "render_template" ? { idOrAlias: "welcome" } : {};
    assert.equal((await callTool(client, name, input, true)).isError, undefined);
  }
  assert.deepEqual(calls.at(-1), { method: "templates.render", args: ["welcome", {}, {}] });
});

test("invalid inputs do not invoke SDK methods", async () => {
  const { client, calls } = fixture();
  for (const [name, input] of [
    ["get_email", null], ["get_email", []], ["get_email", { id: 1 }],
    ["get_email", { id: "" }], ["get_email", { id: "a", apiKey: "secret" }],
    ["list_emails", { limit: 0 }], ["list_emails", { limit: 1.5 }],
    ["list_templates", { status: "deleted" }], ["list_emails", { after: "a", before: "b" }],
    ["send_event", { event: "x" }], ["send_event", { event: "x", contactId: "a", email: "b" }],
    ["send_email", { from: "a", to: "b", idempotency_key: "unsupported" }],
    ["send_email", { from: "a", to: "b", attachments: [{ filename: "a", contentType: 7 }] }],
    ["render_template", { idOrAlias: "a", draft: "true" }],
    ["get_metrics", { automationId: "not-an-array" }]
  ] as const) {
    assert.equal((await callTool(client, name, input)).isError, true, name);
  }
  assert.deepEqual(calls, []);
});

test("email event identity, optional defaults and published template render map exactly", async () => {
  const { client, calls } = fixture();
  await callTool(client, "send_event", { email: "reader@example.com", event: "paid" });
  await callTool(client, "send_email", { from: "app@example.com", to: "reader@example.com", text: "Hi" });
  await callTool(client, "render_template", { idOrAlias: "welcome", draft: false });
  assert.deepEqual(calls, [
    { method: "events.send", args: [{ email: "reader@example.com", event: "paid" }] },
    { method: "emails.send", args: [{ from: "app@example.com", to: "reader@example.com", text: "Hi" }, {}] },
    { method: "templates.render", args: ["welcome", {}, { draft: false }] }
  ]);
});

test("SDK errors explicitly set isError and discard transport headers and arbitrary error extras", async () => {
  const { client } = fixture();
  client.emails.get = async () => ({
    data: null,
    error: { name: "validation_error", statusCode: 422, message: "Invalid email", authorization: "hidden" },
    headers: { authorization: "Bearer hidden", "set-cookie": "hidden" }
  });
  const result = await callTool(client, "get_email", { id: "email" });
  assert.equal(result.isError, true);
  assert.deepEqual(JSON.parse(result.content[0].text), { name: "validation_error", statusCode: 422, message: "Invalid email" });
  assert.ok(!JSON.stringify(result).includes("hidden"));
  client.emails.get = async () => { throw new Error("https://user:secret@example.com Bearer hidden"); };
  const thrown = await callTool(client, "get_email", { id: "email" });
  assert.equal(thrown.isError, true);
  assert.ok(!JSON.stringify(thrown).includes("secret"));
  assert.ok(!JSON.stringify(thrown).includes("hidden"));
});
