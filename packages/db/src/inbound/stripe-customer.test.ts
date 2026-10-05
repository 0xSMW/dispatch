import { describe, expect, it, vi } from "vitest";
import { stripeCustomer } from "./stripe-customer.js";

const customerId = "cus_synthetic";
const key = "rk_test_synthetic";

describe("restricted Stripe customer transport", () => {
  it("uses only the hardcoded customer GET endpoint and refuses redirects", async () => {
    const transport = vi.fn(async () => new Response(JSON.stringify({
      id: customerId, email: " Ada@Example.com ", metadata: { secret: "not_returned" },
    })));
    expect(await stripeCustomer(customerId, key, transport)).toEqual({
      id: customerId, email: "ada@example.com",
    });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport).toHaveBeenCalledWith(`https://api.stripe.com/v1/customers/${customerId}`, {
      method: "GET", headers: { Authorization: `Bearer ${key}` },
      redirect: "error", signal: expect.any(AbortSignal),
    });
  });

  it.each(["cus_../other", "https://example.com", "cus_synthetic?expand=secret", "cus_"])(
    "rejects unsafe customer path %s before transport", async (id) => {
      const transport = vi.fn();
      await expect(stripeCustomer(id, key, transport)).rejects.toThrow("Invalid Stripe customer lookup");
      expect(transport).not.toHaveBeenCalled();
    },
  );

  it.each(["sk_test_synthetic", "pk_test_synthetic", "rk_test_synthetic\nInjected", "rk_test_"])(
    "requires a restricted key: %s", async (invalidKey) => {
      const transport = vi.fn();
      await expect(stripeCustomer(customerId, invalidKey, transport)).rejects.toThrow("Invalid Stripe customer lookup");
      expect(transport).not.toHaveBeenCalled();
    },
  );

  it("treats a missing or deleted customer as unavailable without using a stale address", async () => {
    expect(await stripeCustomer(customerId, key, async () => new Response(null, { status: 404 }))).toBeNull();
    expect(await stripeCustomer(customerId, key, async () => new Response(JSON.stringify({
      id: customerId, deleted: true, email: "stale@example.com",
    })))).toEqual({ id: customerId, deleted: true });
  });

  it("does not return an invalid customer address", async () => {
    expect(await stripeCustomer(customerId, key, async () => new Response(JSON.stringify({
      id: customerId, email: "invalid",
    })))).toEqual({ id: customerId, email: null });
  });

  it.each([
    async () => new Response("provider body containing secret", { status: 403 }),
    async () => new Response(JSON.stringify({ id: "cus_other", email: "other@example.com" })),
    async () => new Response("invalid json"),
    async () => { throw new Error(`transport error ${key}`); },
  ])("sanitizes transport, response and identity errors", async (transport) => {
    await expect(stripeCustomer(customerId, key, transport)).rejects.toThrow("Stripe customer lookup failed");
    try {
      await stripeCustomer(customerId, key, transport);
    } catch (error) {
      expect((error as Error).message).not.toContain(key);
      expect((error as Error).message).not.toContain("provider body");
    }
  });
});
