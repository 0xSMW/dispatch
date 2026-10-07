// Authored for wave 8: these tests require the real external SDK, not a protocol
// stand-in. They must remain unrun until dependency installation/linking is done.
import assert from "node:assert/strict";
import { test } from "vitest";
import { Dispatch } from "@dispatchmail/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { config, createServer } from "./server.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

function body(result: unknown) {
  const value = result as CallToolResult;
  assert.equal(value.content[0].type, "text");
  return JSON.parse((value.content[0] as { type: "text"; text: string }).text);
}

test("config accepts only environment URL/key and --read-only, with no credential flags or fallback env overrides", () => {
  assert.deepEqual(config({ DISPATCH_API_KEY: "test", DISPATCH_API_URL: "https://dispatch.example.test" }, ["--read-only"]),
    { apiKey: "test", baseUrl: "https://dispatch.example.test", readOnly: true });
  assert.equal(config({ DISPATCH_API_KEY: "test", DISPATCH_BASE_URL: "https://ignored.example.test" }).baseUrl, "http://localhost:3100");
  assert.throws(() => config({}), /required/);
  assert.throws(() => config({ DISPATCH_API_KEY: "test" }, ["--api-key=test"]), /Unsupported/);
  for (const url of ["ftp://example.test", "https://user:secret@example.test", "https://example.test?apiKey=secret"]) {
    assert.throws(() => config({ DISPATCH_API_KEY: "test", DISPATCH_API_URL: url }));
  }
});

async function session(readOnly: boolean, run: (client: Client, requests: Array<{ url: string; options: RequestInit }>) => Promise<void>) {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; options: RequestInit }> = [];
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    const path = new URL(String(url)).pathname;
    if (path === "/emails/missing") {
      return Response.json({ name: "not_found", statusCode: 404, message: "Email not found", authorization: "DO_NOT_EMIT" },
        { status: 404, headers: { authorization: "Bearer DO_NOT_EMIT", "set-cookie": "DO_NOT_EMIT" } });
    }
    return Response.json(path.endsWith("/render") ? { rendered: { html: "<p>Ada</p>" } } : { id: "result" },
      { headers: { authorization: "Bearer DO_NOT_EMIT", "set-cookie": "DO_NOT_EMIT" } });
  };
  const server = createServer(new Dispatch({ apiKey: "TEST_SECRET_DO_NOT_EMIT", baseUrl: "https://dispatch.example.test" }), readOnly);
  const client = new Client({ name: "dispatch-mcp-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    await run(client, requests);
  } finally {
    await client.close();
    await server.close();
    globalThis.fetch = originalFetch;
  }
}

test("actual MCP initialization/list/call routes send and preset install through real Dispatch SDK", async () => {
  await session(false, async (client, requests) => {
    assert.equal(client.getServerVersion()?.name, "@dispatchmail/mcp");
    assert.deepEqual(client.getServerCapabilities(), { tools: {} });
    const list = await client.listTools();
    assert.equal(list.tools.length, 10);
    assert.ok(!JSON.stringify(list).includes("TEST_SECRET"));
    const sent = await client.callTool({ name: "send_email", arguments: {
      from: "app@example.test", to: "reader@example.test", replyTo: "reply@example.test",
      topicId: "topic", template: { id: "welcome", variables: { firstName: "Ada" } }, idempotencyKey: "mcp-send-1"
    } });
    assert.deepEqual(body(sent), { id: "result" });
    assert.equal(requests[0].options.method, "POST");
    assert.equal(new Headers(requests[0].options.headers).get("idempotency-key"), "mcp-send-1");
    assert.deepEqual(JSON.parse(requests[0].options.body as string), {
      from: "app@example.test", to: "reader@example.test", reply_to: "reply@example.test",
      topic_id: "topic", template: { id: "welcome", variables: { firstName: "Ada" } }
    });
    const installed = await client.callTool({ name: "install_preset", arguments: {
      slug: "newsletter-welcome", from: "app@example.test", topicId: "topic", name: "Welcome"
    } });
    assert.deepEqual(body(installed), { id: "result" });
    assert.equal(requests[1].url, "https://dispatch.example.test/template-library/automations/newsletter-welcome/install");
    assert.deepEqual(JSON.parse(requests[1].options.body as string), { from: "app@example.test", topic_id: "topic", name: "Welcome" });
    assert.ok(!JSON.stringify([sent, installed]).includes("DO_NOT_EMIT"));
  });
});

test("actual MCP read-only discovery/calls reject all hidden writes and permit POST render", async () => {
  await session(true, async (client, requests) => {
    assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name),
      ["get_email", "list_emails", "list_automations", "get_metrics", "list_templates", "render_template"]);
    for (const name of ["send_email", "send_event", "upsert_contact", "install_preset"]) {
      const denied = await client.callTool({ name, arguments: { readOnly: false } });
      assert.equal(denied.isError, true);
      assert.equal(body(denied).name, "read_only");
    }
    assert.equal(requests.length, 0);
    for (const name of ["list_emails", "list_automations", "get_metrics", "list_templates"]) {
      assert.equal((await client.callTool({ name, arguments: {} })).isError, undefined);
    }
    await client.callTool({ name: "get_email", arguments: { id: "email" } });
    const rendered = await client.callTool({ name: "render_template", arguments: {
      idOrAlias: "welcome", variables: { firstName: "Ada" }, draft: true
    } });
    assert.deepEqual(body(rendered), { rendered: { html: "<p>Ada</p>" } });
    assert.equal(requests.at(-1)?.options.method, "POST");
    assert.deepEqual(JSON.parse(requests.at(-1)!.options.body as string), { variables: { firstName: "Ada" }, draft: true });
  });
});

test("actual MCP call results preserve explicit SDK errors and hide response auth headers", async () => {
  await session(false, async (client, requests) => {
    const result = await client.callTool({ name: "get_email", arguments: { id: "missing" } });
    assert.equal(result.isError, true);
    assert.deepEqual(body(result), { name: "not_found", statusCode: 404, message: "Email not found" });
    assert.ok(!JSON.stringify(result).includes("DO_NOT_EMIT"));
    const unknown = await client.callTool({ name: "call", arguments: { path: "/emails", method: "POST" } });
    assert.equal(unknown.isError, true);
    assert.equal(requests.length, 1);
  });
});
