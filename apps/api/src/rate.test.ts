import type { Redis } from "ioredis";
import { describe, expect, it } from "vitest";
import { rateKey, rateLimitValue, signinKey, signins, signinWindow } from "./rate.js";

describe("rate limit", () => {
  it("keys one bucket per tenant per second, whatever the key or route", () => {
    expect(rateKey("tenant_1", 1_700_000_000_999)).toBe("rate:tenant_1:1700000000");
    expect(rateKey("tenant_1", 1_700_000_001_000)).toBe("rate:tenant_1:1700000001");
  });

  it("defaults to 10 per second and lets RATE_LIMIT_PER_SECOND override it", () => {
    expect(rateLimitValue({})).toBe(10);
    expect(rateLimitValue({ RATE_LIMIT_PER_SECOND: "1000" })).toBe(1000);
    expect(rateLimitValue({ RATE_LIMIT_PER_SECOND: "nope" })).toBe(10);
  });
});

describe("sign-in failures", () => {
  // Redis in memory: values and the expiry each key was given.
  function fake() {
    const values = new Map<string, number>();
    const expiries = new Map<string, number>();
    const redis = {
      // The give-back script: decrement only a key that still exists.
      eval: async (_script: string, _keys: number, key: string) => (values.has(key) ? values.set(key, values.get(key)! - 1).get(key) : 0),
      multi() {
        const steps: Array<() => void> = [];
        const chain = {
          set(key: string, value: number, _ex: "EX", seconds: number, _nx: "NX") {
            steps.push(() => {
              if (values.has(key)) return;
              values.set(key, value);
              expiries.set(key, seconds);
            });
            return chain;
          },
          incr(key: string) {
            steps.push(() => values.set(key, (values.get(key) ?? 0) + 1).get(key));
            return chain;
          },
          async exec() {
            return steps.map((step) => [null, step()]);
          },
        };
        return chain;
      },
    };
    return { values, expiries, guard: signins(redis as unknown as Redis) };
  }

  it("keys one counter per email, whatever its case", () => {
    expect(signinKey(" Ada@Example.com ")).toBe("signin:ada@example.com");
  });

  it("gives each email 10 slots in a 15 minute window that starts at the first attempt", async () => {
    const { values, expiries, guard } = fake();
    for (let index = 0; index < 10; index++) expect(await guard.take(index % 2 ? "ADA@example.com" : "ada@example.com")).toBe(true);
    expect(await guard.take("Ada@example.com")).toBe(false);
    expect(await guard.take("grace@example.com")).toBe(true);
    expect(expiries.get("signin:ada@example.com")).toBe(signinWindow);
    expect(signinWindow).toBe(900);
    // A right password gives back its own slot and nothing more.
    await guard.release("ada@example.com");
    expect(values.get("signin:ada@example.com")).toBe(10);
  });

  it("gives nothing back once the window has ended, so no key is left without an expiry", async () => {
    const { values, guard } = fake();
    await guard.release("ada@example.com");
    expect(values.has("signin:ada@example.com")).toBe(false);
  });
});
