import { afterEach, expect, it, vi } from "vitest";
import { Dispatch } from "./index.js";

// Authored for the milestone 8 SDK gate; not executed during engineering.
afterEach(() => vi.unstubAllGlobals());
it("manages form IDs with snake_case fields and preserves false/null", async () => {
  const fetch = vi.fn(async () => new Response(JSON.stringify({ object: "form", id: "form_1" }), { status: 200 }));
  vi.stubGlobal("fetch", fetch);
  const client = new Dispatch({ apiKey: "synthetic-key" });
  await client.forms.create({ name: "News", topicIds: ["topic_1"], fromEmail: "hello@example.com", allowedOrigins: ["https://example.com"], doubleOptIn: false });
  await client.forms.update("form_1", { doubleOptIn: false, redirectUrl: null });
  const [, init] = fetch.mock.calls[1] as unknown as [string, RequestInit];
  expect(JSON.parse(String(init.body))).toEqual({ double_opt_in: false, redirect_url: null });
  await client.forms.list();
  await client.forms.get("form_1");
  await client.forms.remove("form_1");
  expect(fetch).toHaveBeenCalledTimes(5);
});
