import { afterEach, expect, it, vi } from "vitest";
import { Dispatch } from "./index.js";

// Authored for milestone8; SDK gates are not executed during engineering.
afterEach(() => vi.unstubAllGlobals());
it("maps integration settings without losing false/null and exposes credentials only in create/rotate shapes", async () => {
  const fetch = vi.fn(async () => new Response(JSON.stringify({ object: "integration", id: "int_1" }), { status: 200 }));
  vi.stubGlobal("fetch", fetch);
  const client = new Dispatch({ apiKey: "synthetic-key" });
  await client.integrations.create({ provider: "webhook", name: "App", secret: "synthetic", settings: { deleteContact: false } });
  await client.integrations.update("int_1", { settings: { mapPlan: false, stripeRestrictedKey: null } });
  const [, init] = fetch.mock.calls[1] as unknown as [string, RequestInit];
  expect(JSON.parse(String(init.body))).toEqual({ settings: { map_plan: false, stripe_restricted_key: null } });
  await client.integrations.list();
  await client.integrations.get("int_1");
  await client.integrations.deliveries("int_1", { limit: 20 });
  await client.integrations.rotate("int_1");
  await client.integrations.remove("int_1");
  expect(fetch).toHaveBeenCalledTimes(7);
  expect(String((fetch.mock.calls[4] as unknown as [string])[0])).toMatch(/\/integrations\/int_1\/deliveries\?limit=20$/);
});
