import { tx, type Db } from "@dispatchmail/db";
import type { Storage } from "@dispatchmail/storage";

// Journal entries are created before upload on a separate committed connection. The writer
// holds the same advisory lock until its metadata transaction commits or rolls back.
export async function cleanStorage(db: Db, storage: Pick<Storage, "delete">) {
  await tx(db, async (client) => {
    const pending = await client.query<{ storage_key: string }>(
      "select storage_key from pending_blobs where created_at < now() - interval '1 hour' order by created_at limit 100 for update skip locked",
    );
    for (const { storage_key: key } of pending.rows) {
      const lock = await client.query<{ locked: boolean }>("select pg_try_advisory_xact_lock(hashtextextended($1, 29)) as locked", [key]);
      if (!lock.rows[0]?.locked) continue;
      const refs = await client.query(`select 1 from email_attachments where storage_key = $1
        union all select 1 from received_attachments where storage_key = $1
        union all select 1 from received_emails where raw_key = $1 limit 1`, [key]);
      if (!refs.rows[0]) await storage.delete(key);
      await client.query("delete from pending_blobs where storage_key = $1", [key]);
    }
    const imports = await client.query<{ id: string; storage_key: string }>(`select id, storage_key from contact_imports
      where status in ('completed', 'failed', 'cancelled') and source_deleted_at is null
      order by completed_at limit 100 for update skip locked`);
    for (const row of imports.rows) {
      await storage.delete(row.storage_key);
      await client.query("update contact_imports set source_deleted_at = now() where id = $1", [row.id]);
    }
  });
}
