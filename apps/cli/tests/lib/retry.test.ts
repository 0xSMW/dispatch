import { afterEach, describe, expect, it, vi } from "vitest";
import { delay, retry, retrying, timing } from "../../src/lib/retry.js";

const limited = (after?: string) => ({
  data: null,
  error: { name: "rate_limit_exceeded", statusCode: 429, message: "slow" },
  headers: after ? { "retry-after": after } : {},
});
const ok = { data: { id: "x" }, error: null, headers: {} };

describe("retry", () => {
  const sleep = vi.spyOn(timing, "sleep").mockResolvedValue(undefined);
  afterEach(() => sleep.mockClear());

  it("retries a 429 and honors Retry-After in seconds", async () => {
    const call = vi.fn().mockResolvedValueOnce(limited("2")).mockResolvedValueOnce(ok);
    expect(await retry(call)).toBe(ok);
    expect(call).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it("gives up after three retries and returns the last 429", async () => {
    const call = vi.fn().mockResolvedValue(limited());
    const result = await retry(call);
    expect(call).toHaveBeenCalledTimes(4);
    expect(result.error?.statusCode).toBe(429);
  });

  it("does not retry other errors", async () => {
    const call = vi.fn().mockResolvedValue({ data: null, error: { name: "not_found", statusCode: 404, message: "x" }, headers: {} });
    await retry(call);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("backs off exponentially without Retry-After and caps long waits", () => {
    expect(delay({}, 0)).toBe(500);
    expect(delay({}, 2)).toBe(2000);
    expect(delay({ "retry-after": "600" }, 0)).toBe(60_000);
  });

  it("wraps nested client methods, keeping this", async () => {
    const calls: unknown[] = [];
    class Emails {
      tries = 0;
      async send(payload: unknown) {
        calls.push(payload);
        this.tries += 1;
        return this.tries === 1 ? limited("0") : ok;
      }
      verify() {
        return "sync";
      }
    }
    const client = retrying({ emails: new Emails() });
    expect(await client.emails.send({ to: "a" })).toBe(ok);
    expect(calls).toHaveLength(2);
    expect(client.emails.verify()).toBe("sync");
  });
});
