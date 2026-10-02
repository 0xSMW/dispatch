import { setTimeout as wait } from "node:timers/promises";

type Settled = { error?: { statusCode?: number | null; name?: string } | null; headers?: Record<string, string> | null };

export const timing = { sleep: (ms: number) => wait(ms).then(() => undefined) };

export function delay(headers: Record<string, string> | null | undefined, attempt: number) {
  const header = headers?.["retry-after"];
  const seconds = header === undefined ? Number.NaN : Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds, 60) * 1000;
  if (header) {
    const at = Date.parse(header);
    if (!Number.isNaN(at)) return Math.min(Math.max(at - Date.now(), 0), 60_000);
  }
  return 2 ** attempt * 500;
}

function limited(result: unknown): result is Settled {
  const error = (result as Settled | null)?.error;
  return Boolean(error && (error.statusCode === 429 || error.name === "rate_limit_exceeded"));
}

// Retry a call up to three times on 429, honoring Retry-After.
export async function retry<T>(call: () => Promise<T>, tries = 3): Promise<T> {
  let result = await call();
  for (let attempt = 0; attempt < tries && limited(result); attempt += 1) {
    await timing.sleep(delay(result.headers, attempt));
    result = await call();
  }
  return result;
}

function child(holder: object, prop: string | symbol): unknown {
  const value = Reflect.get(holder, prop);
  if (typeof prop === "symbol" || prop === "then") return value;
  const descriptor = Reflect.getOwnPropertyDescriptor(holder, prop);
  if (descriptor && !descriptor.configurable && !descriptor.writable) return value;
  if (value && (typeof value === "object" || typeof value === "function")) return wrap(value as object, holder);
  return value;
}

function wrap(value: object, owner: object): object {
  return new Proxy(value, {
    get: (target, prop) => child(target, prop),
    apply: (target, _self, args) => {
      const call = () => Reflect.apply(target as (...args: unknown[]) => unknown, owner, args);
      const first = call();
      if (!first || typeof (first as Promise<unknown>).then !== "function") return first;
      let used = false;
      return retry(() => {
        if (used) return call() as Promise<unknown>;
        used = true;
        return first as Promise<unknown>;
      });
    },
  });
}

// Wrap every method on a client, at any depth, with retry().
export function retrying<T extends object>(client: T): T {
  return new Proxy(client, { get: (target, prop) => child(target, prop) }) as T;
}
