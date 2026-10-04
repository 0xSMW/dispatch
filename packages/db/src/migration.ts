import type { Db } from "./index.js";
import { retryTx } from "./retry.js";
import { schema } from "./schema.js";

// Capture the event-only schema before the full SQL adds trigger_type. Keep the
// capture, upgrade, and bounded root backfill on one locked connection. This is
// transaction-local provenance, not a registry or a heuristic about run contents.
export async function migrate(db: Db): Promise<void> {
  await retryTx(db, async (client) => {
    await client.query("select pg_advisory_xact_lock(1869440356, 1)");
    const tables = await client.query<{ automations: string | null; runs: string | null }>(
      "select to_regclass('automations')::text as automations, to_regclass('automation_runs')::text as runs"
    );
    let eventOnly = false;
    if (tables.rows[0]?.automations && tables.rows[0].runs) {
      // Stop old event writers before examining the discriminator or changing
      // depth. A writer already in flight must finish before these locks succeed.
      await client.query("lock table automations, automation_runs in access exclusive mode");
      const columns = await client.query<{ event_only: boolean }>(
        `select not exists (
           select 1 from pg_attribute where attrelid = 'automations'::regclass
             and attname = 'trigger_type' and not attisdropped
         ) and not exists (
           select 1 from pg_attribute where attrelid = 'automation_runs'::regclass
             and attname = 'depth' and not attisdropped
         ) as event_only`
      );
      eventOnly = columns.rows[0]?.event_only === true;
    }
    await client.query("select set_config('dispatch.legacy_event_roots', $1, true)", [String(eventOnly)]);
    await client.query(schema);
  });
}
