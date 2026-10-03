import type { Queryable } from "@dispatchmail/db";

const pruneIntervalMs = 60_000;

export function retentionDays(value = Number(process.env.LOG_RETENTION_DAYS ?? 30)) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 30;
}

const pruneBatch = 10_000;

// Deletes in batches. One statement over a large backlog would hold the worker loop and write a
// very large WAL record. Whatever is left is picked up on the next pass a minute later.
export async function pruneLogs(db: Queryable, days = retentionDays(), batch = pruneBatch, maxBatches = 20) {
  let removed = 0;
  for (let pass = 0; pass < maxBatches; pass += 1) {
    const result = await db.query(
      `delete from logs where id in (
         select id from logs where created_at < now() - ($1::int * interval '1 day') limit $2
       )`,
      [days, batch],
    );
    const count = result.rowCount ?? 0;
    removed += count;
    if (count < batch) break;
  }
  return removed;
}

export async function pruneLogsIfDue(
  db: Queryable,
  state: { last: number },
  now = Date.now(),
  days = retentionDays(),
) {
  if (now - state.last < pruneIntervalMs) return 0;
  state.last = now;
  return pruneLogs(db, days);
}

export function contactChangesRetentionDays(value = Number(process.env.CONTACT_CHANGES_RETENTION_DAYS ?? 400)) {
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : 400;
}

export async function pruneContactChanges(db: Queryable, days = contactChangesRetentionDays(), batch = pruneBatch, maxBatches = 20) {
  let removed = 0;
  for (let pass = 0; pass < maxBatches; pass += 1) {
    const result = await db.query(
      `delete from contact_changes where id in (
         select id from contact_changes where created_at < now() - ($1::int * interval '1 day')
         order by created_at, id limit $2
       )`, [days, batch],
    );
    const count = result.rowCount ?? 0;
    removed += count;
    if (count < batch) break;
  }
  return removed;
}

export async function pruneContactChangesIfDue(db: Queryable, state: { last: number }, now = Date.now()) {
  if (now - state.last < pruneIntervalMs) return 0;
  state.last = now;
  return pruneContactChanges(db);
}
