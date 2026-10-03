import { randomUUID } from "node:crypto";
import type { Queryable } from "@dispatchmail/db";
import { signinKey, signinLimit, signinWindow, type Signins } from "./rate.js";

type Counter = { value: string; window_id: string };

// One upsert takes the row lock and increments the counter, even across API replicas.
// Refreshing the two-second expiry matches the Redis request counter; the key itself
// contains the second, so requests in later seconds always use another bucket.
export async function countHit(db: Queryable, key: string) {
  const result = await db.query<Counter>(
    `insert into counters (key, value, expires_at, window_id)
     values ($1, 1, statement_timestamp() + interval '2 seconds', $2)
     on conflict (key) do update set
       value = case when counters.expires_at <= statement_timestamp() then 1 else counters.value + 1 end,
       expires_at = statement_timestamp() + interval '2 seconds',
       window_id = excluded.window_id
     returning value::text, window_id`,
    [key, randomUUID()],
  );
  const count = Number(result.rows[0]?.value);
  if (!Number.isSafeInteger(count) || count < 1) throw new Error("rate limit counter unavailable");
  return count;
}

export function postgresSignins(db: Queryable): Signins {
  return {
    async take(email) {
      const result = await db.query<Counter>(
        `insert into counters (key, value, expires_at, window_id)
         values ($1, 1, statement_timestamp() + $2 * interval '1 second', $3)
         on conflict (key) do update set
           value = case when counters.expires_at <= statement_timestamp() then 1 else counters.value + 1 end,
           window_id = case when counters.expires_at <= statement_timestamp() then excluded.window_id else counters.window_id end,
           expires_at = case when counters.expires_at <= statement_timestamp() then excluded.expires_at else counters.expires_at end
         returning value::text, window_id`,
        [signinKey(email), signinWindow, randomUUID()],
      );
      const row = result.rows[0];
      const count = Number(row?.value);
      if (!row?.window_id || !Number.isSafeInteger(count) || count < 1) throw new Error("sign-in counter unavailable");
      return count <= signinLimit ? row.window_id : false;
    },
    async release(email, reservation) {
      if (typeof reservation !== "string") return;
      // A password check may finish after the original window_id expired. Its token
      // cannot give back a slot from a later window_id, even on a different replica.
      await db.query(
        `update counters set value = greatest(value - 1, 0)
         where key = $1 and window_id = $2 and expires_at > clock_timestamp()`,
        [signinKey(email), reservation],
      );
    },
  };
}

// Expired rows do not affect correctness. Bound each maintenance pass so cleanup
// does not hold a large number of row locks while requests are using the table.
export async function pruneCounters(db: Queryable, limit = 1000) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("counter cleanup limit must be positive");
  await db.query(
    `delete from counters where key in (
       select key from counters where expires_at <= clock_timestamp()
       order by expires_at limit $1 for update skip locked
     )`,
    [limit],
  );
}
