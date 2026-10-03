import type { Redis } from "ioredis";

// The bucket rule lives in core so the SMTP relay counts into the same buckets.
export { rateKey, rateLimitValue, sessionRateKey, sessionRateLimitValue } from "@dispatchmail/core";

// After 10 failed sign-ins for one email within 15 minutes, every attempt for that email is
// refused until the window ends. The window starts at the first attempt. Nothing clears it early:
// one email can belong to several tenants, and a clear from one would reset the count that
// guards another.
export const signinLimit = 10;
export const signinWindow = 15 * 60;

export function signinKey(email: string) {
  return `signin:${email.trim().toLowerCase()}`;
}

// Gives a slot back only while the window lasts, so a late release cannot leave a key with no expiry.
const giveBack = "if redis.call('exists', KEYS[1]) == 1 then return redis.call('decr', KEYS[1]) end return 0";

export function signins(redis: Pick<Redis, "multi" | "eval">) {
  return {
    // Every attempt takes a slot before the password is checked, so attempts that arrive together
    // all count. False once the email has used its slots. The window starts in the same round
    // trip as the count, so a process that stops between the two cannot leave a counter with no expiry.
    async take(email: string) {
      const result = await redis.multi().set(signinKey(email), 0, "EX", signinWindow, "NX").incr(signinKey(email)).exec();
      return Number(result?.[1]?.[1]) <= signinLimit;
    },
    // A right password gives back the slot it took. Only failures stay counted.
    async release(email: string) {
      await redis.eval(giveBack, 1, signinKey(email));
    },
  };
}

// Successful PostgreSQL reservations carry their window token through the password check.
// Redis adapters keep their boolean result for local use.
export type Signins = {
  take(email: string): Promise<boolean | string>;
  release(email: string, reservation?: boolean | string): Promise<void>;
};
