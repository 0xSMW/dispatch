import { parse } from "csv-parse";
import { isIsoDate, type ImportColumnMap, type PropertyType } from "@dispatchmail/core";
import {
  claimImports,
  dedupeByEmail,
  emptyCounts,
  finishImport,
  importBatch,
  isDeadlock,
  propertyDefinitions,
  retryTx,
  saveImportCounts,
  tx,
  type Db,
  type ImportContact,
  type ImportCounts,
  type ImportRow,
  type PropertyDefinition,
} from "@dispatchmail/db";
import type { Storage } from "@dispatchmail/storage";

export const batchSize = 1_000;

type ColumnType = PropertyType;

export type Columns = {
  email: string;
  first_name?: string;
  last_name?: string;
  unsubscribed?: string;
  properties: Array<{ key: string; column: string; type: ColumnType }>;
};

const emailPattern = /^[^\s@<>()",;]+@[^\s@<>()",;]+\.[^\s@<>()",;]+$/;
const trueValues = new Set(["true", "yes", "y", "1", "unsubscribed"]);
const propertyBooleans = new Map([["true", true], ["yes", true], ["1", true], ["false", false], ["no", false], ["0", false]]);
const defaults = {
  email: ["email", "email_address", "e-mail", "email address"],
  first_name: ["first_name", "firstname", "first name"],
  last_name: ["last_name", "lastname", "last name"],
  unsubscribed: ["unsubscribed"],
};

const running = { count: 0 };

// Claims queued imports up to the concurrency cap and runs them in the background,
// so a large file never holds up send jobs in the same tick.
export async function startImports(
  db: Db,
  storage: Pick<Storage, "stream">,
  state = running,
  max = Number(process.env.IMPORT_CONCURRENCY ?? 1),
  options: { bounded?: boolean } = {},
) {
  const free = max - state.count;
  if (free <= 0) return 0;
  const imports = await claimImports(db, free);
  if (options.bounded) {
    // A serverless step must finish its work before returning. Each pass commits one batch,
    // then leaves the import queued for another durable step.
    await Promise.all(imports.map((job) => runImport(db, storage, job, { maxRows: batchSize })));
    return imports.length;
  }
  for (const job of imports) {
    state.count += 1;
    void runImport(db, storage, job)
      .catch((error) => console.error(error))
      .finally(() => {
        state.count -= 1;
      });
  }
  return imports.length;
}

export async function runImport(
  db: Db,
  storage: Pick<Storage, "stream">,
  job: ImportRow,
  options: { batchSize?: number; maxRows?: number } = {},
) {
  const size = options.batchSize ?? batchSize;
  // A job taken over from a worker that stopped has rows already committed. Those rows are read
  // again, so total and failed come out right, but they are not written again: writing them
  // would count every contact the first worker created as updated.
  const done = job.row_offset ?? 0;
  const counts = emptyCounts();
  if (done > 0) {
    counts.created = job.counts?.created ?? 0;
    counts.updated = job.counts?.updated ?? 0;
    counts.skipped = job.counts?.skipped ?? 0;
  }
  let seen = 0;
  let source: Awaited<ReturnType<Storage["stream"]>> | undefined;
  let parser: ReturnType<typeof parse> | undefined;
  try {
    const definitions = await propertyDefinitions(db, job.tenant_id);
    source = await storage.stream(job.storage_key);
    const header: { columns?: Columns } = {};
    const broken: { message?: string } = {};
    parser = parse({
      bom: true,
      trim: true,
      skip_empty_lines: true,
      relax_column_count: true,
      skip_records_with_error: true,
      columns: (names: string[]) => {
        const trimmed = names.map((name) => name.trim());
        header.columns = resolveColumns(trimmed, job.column_map ?? {}, definitions);
        return trimmed;
      },
      on_skip: (error) => {
        counts.total += 1;
        counts.failed += 1;
        // An unclosed quote swallows every row after it into one bad record. That is a broken
        // file, not one bad row, so the import fails and says where.
        if ((error as { code?: string } | undefined)?.code === "CSV_QUOTE_NOT_CLOSED") {
          broken.message = `The CSV has a quote that is never closed${typeof (error as { lines?: number }).lines === "number" ? `, near line ${(error as { lines?: number }).lines}` : ""}`;
        }
        return undefined;
      },
    });
    source.on("error", (error) => parser?.destroy(error));
    source.pipe(parser);

    let batch: ImportContact[] = [];
    for await (const record of parser as AsyncIterable<Record<string, string>>) {
      counts.total += 1;
      seen += 1;
      const contact = header.columns ? mapRecord(record, header.columns) : null;
      if (!contact) {
        counts.failed += 1;
      }
      if (seen <= done) continue;
      if (contact) batch.push(contact);
      if (batch.length >= size) {
        await flush(db, job, batch, counts, seen);
        batch = [];
      }
      if (options.maxRows && seen - done >= options.maxRows) {
        if (batch.length > 0) await flush(db, job, batch, counts, seen);
        await tx(db, async (client) => {
          await ownImport(client, job);
          if (batch.length === 0) await saveImportCounts(client, job.id, counts, seen);
          await client.query("update contact_imports set status = 'queued', locked_at = null where tenant_id = $1 and id = $2", [job.tenant_id, job.id]);
        });
        source.pause();
        if ("destroy" in source && typeof source.destroy === "function") source.destroy();
        parser.destroy();
        return counts;
      }
    }
    if (batch.length > 0) await flush(db, job, batch, counts, seen);
    if (broken.message) throw new Error(broken.message);
    await tx(db, async (client) => {
      await ownImport(client, job);
      await finishImport(client, job.id, "completed", counts);
    });
  } catch (error) {
    if (error instanceof ImportInterrupted) return counts;
    // An exhausted aborted batch leaves only prior committed progress. Keep it reclaimable;
    // do not fail or requeue a job that may have been cancelled or taken over meanwhile.
    if (isDeadlock(error)) return counts;
    await tx(db, async (client) => {
      try { await ownImport(client, job); }
      catch (ownership) { if (ownership instanceof ImportInterrupted) return; throw ownership; }
      await finishImport(client, job.id, "failed", counts, error instanceof Error ? error.message : String(error));
    });
  } finally {
    parser?.destroy();
    if (source && "destroy" in source && typeof source.destroy === "function") source.destroy();
  }
  return counts;
}

// Upserts one batch and writes progress in the same transaction. Mutates counts once the batch commits.
export async function flush(db: Db, job: ImportRow, batch: ImportContact[], counts: ImportCounts, offset = 0) {
  const { rows, dropped } = dedupeByEmail(batch);
  const result = await retryTx(db, async (client) => {
    const current = await ownImport(client, job);
    if (offset > 0 && (current.row_offset ?? 0) >= offset) throw new ImportInterrupted();
    const done = await importBatch(client, job, rows);
    await saveImportCounts(
      client,
      job.id,
      {
        ...counts,
        created: counts.created + done.created,
        updated: counts.updated + done.updated,
        skipped: counts.skipped + done.skipped + dropped,
      },
      offset,
    );
    return done;
  });
  counts.created += result.created;
  counts.updated += result.updated;
  counts.skipped += result.skipped + dropped;
  return counts;
}

class ImportInterrupted extends Error {}

async function ownImport(client: { query: Db["query"] }, job: ImportRow) {
  const found = await client.query<ImportRow>(
    "select status, row_offset, claim_version from contact_imports where tenant_id = $1 and id = $2 for update",
    [job.tenant_id, job.id],
  );
  const current = found.rows[0];
  if (!current || current.status !== "in_progress" || (current.claim_version ?? 0) !== (job.claim_version ?? 0)) {
    throw new ImportInterrupted();
  }
  return current;
}

export function resolveColumns(header: string[], map: ImportColumnMap, definitions: PropertyDefinition[]): Columns {
  // With two columns of one name the parser keeps the last, and the wrong address is imported.
  const seen = new Set<string>();
  for (const name of header) {
    const key = name.toLowerCase();
    if (key && seen.has(key)) throw new Error(`The CSV has two columns named "${name}"`);
    seen.add(key);
  }
  const find = (name: string) => header.find((column) => column === name) ?? header.find((column) => column.toLowerCase() === name.toLowerCase());
  const mapped = (field: keyof typeof defaults) => {
    // Null means "do not import this field", even if the file has a column with the usual name.
    if (map[field] === null) return undefined;
    const wanted = map[field]?.column;
    if (wanted) {
      const column = find(wanted);
      if (!column) throw new Error(`Column "${wanted}" is not in the CSV header`);
      return column;
    }
    for (const name of defaults[field]) {
      const column = find(name);
      if (column) return column;
    }
    return undefined;
  };
  const email = mapped("email");
  if (!email) throw new Error("The CSV has no email column");
  const types = new Map(definitions.map((row) => [row.key, row.type as ColumnType]));
  const properties = Object.entries(map.properties ?? {}).map(([key, value]) => {
    const column = find(value.column);
    if (!column) throw new Error(`Column "${value.column}" is not in the CSV header`);
    return { key, column, type: types.get(key) ?? value.type ?? "string" };
  });
  return {
    email,
    first_name: mapped("first_name"),
    last_name: mapped("last_name"),
    unsubscribed: mapped("unsubscribed"),
    properties,
  };
}

export function mapRecord(record: Record<string, string | undefined>, columns: Columns): ImportContact | null {
  const email = (record[columns.email] ?? "").trim().toLowerCase();
  if (!emailPattern.test(email)) return null;
  const properties: Record<string, unknown> = {};
  for (const property of columns.properties) {
    const raw = (record[property.column] ?? "").trim();
    if (raw === "") continue;
    if (property.type === "number") {
      const value = Number(raw);
      if (!Number.isFinite(value)) return null;
      properties[property.key] = value;
    } else if (property.type === "boolean") {
      const value = propertyBooleans.get(raw.toLowerCase());
      if (value === undefined) return null;
      properties[property.key] = value;
    } else if (property.type === "date") {
      if (!isIsoDate(raw)) return null;
      properties[property.key] = raw;
    } else {
      properties[property.key] = raw;
    }
  }
  const text = (column?: string) => {
    const value = column ? (record[column] ?? "").trim() : "";
    return value === "" ? null : value;
  };
  return {
    email,
    first_name: text(columns.first_name),
    last_name: text(columns.last_name),
    properties,
    unsubscribed: columns.unsubscribed ? trueValues.has((record[columns.unsubscribed] ?? "").trim().toLowerCase()) : false,
  };
}
