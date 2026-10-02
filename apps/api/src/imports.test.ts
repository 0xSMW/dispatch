import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "@dispatchmail/core";
import type { Db } from "@dispatchmail/db";
import { registerImports, uploadError } from "./imports.js";

type Query = { sql: string; params: unknown[] };

function fakeDb(refs = { segments: 1, topics: 1 }) {
  const queries: Query[] = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    queries.push({ sql, params });
    if (sql.includes("count(*) from segments")) return { rows: [refs] };
    if (sql.startsWith("insert into contact_imports")) return { rows: [{ id: params[0], status: "queued" }] };
    if (sql.includes("from contact_imports")) {
      return {
        rows: [{ id: "import_1", status: "completed", counts: { total: 3, created: 2 }, error: null, created_at: "2026-10-01", completed_at: "2026-10-01" }],
      };
    }
    return { rows: [] };
  });
  return { db: { query } as unknown as Db, queries };
}

async function build(db: Db) {
  const puts: Array<{ key: string; bytes: number; type?: string }> = [];
  const storage = {
    put: vi.fn(async (key: string, body: Buffer | NodeJS.ReadableStream, type?: string) => {
      let bytes = 0;
      for await (const chunk of body as AsyncIterable<Buffer>) bytes += chunk.length;
      puts.push({ key, bytes, type });
    }),
    delete: vi.fn(async () => undefined),
  };
  const app = Fastify();
  app.addHook("preHandler", async (request) => {
    request.auth = { tenant_id: "tenant_1", api_key_id: "key_1", scope: "full" };
  });
  app.setErrorHandler((error, _request, reply) => {
    const status = error instanceof ApiError ? error.statusCode : error.name === "ZodError" ? 400 : 500;
    reply.status(status).send({ name: error.name, message: error.message });
  });
  registerImports(app, {
    db,
    storage,
    paging: (request) => {
      const query = request.query as { limit?: string };
      return { limit: query.limit ? Number(query.limit) : undefined };
    },
  });
  await app.ready();
  return { app, storage, puts };
}

function form(parts: Array<{ name: string; value: string; filename?: string }>) {
  const boundary = "----dispatch";
  const body = parts
    .map((part) =>
      part.filename
        ? `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\nContent-Type: text/csv\r\n\r\n${part.value}\r\n`
        : `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"\r\n\r\n${part.value}\r\n`,
    )
    .join("");
  return { payload: `${body}--${boundary}--\r\n`, headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}

describe("contact import routes", () => {
  it("streams the file to storage, queues an import, and accepts fields after the file", async () => {
    const { db, queries } = fakeDb();
    const { app, puts } = await build(db);
    const csv = "email,first_name\na@example.com,Ada\n";
    const response = await app.inject({
      method: "POST",
      url: "/contacts/imports",
      ...form([
        { name: "file", filename: "contacts.csv", value: csv },
        { name: "column_map", value: JSON.stringify({ first_name: { column: "first_name" } }) },
        { name: "on_conflict", value: "skip" },
        { name: "segments", value: JSON.stringify([{ id: "segment_1" }]) },
        { name: "topics", value: JSON.stringify([{ id: "topic_1", subscription: "opt_out" }]) },
      ]),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({ object: "contact_import" });
    expect(body.id).toMatch(/^import_/);
    expect(puts).toEqual([{ key: `imports/tenant_1/${body.id}`, bytes: csv.length, type: "text/csv" }]);
    const insert = queries.find((query) => query.sql.startsWith("insert into contact_imports"))!;
    expect(insert.params[4]).toBe("skip");
    expect(JSON.parse(insert.params[5] as string)).toEqual([{ id: "segment_1" }]);
    expect(JSON.parse(insert.params[6] as string)).toEqual([{ id: "topic_1", subscription: "opt_out" }]);
  });

  it("rejects a request without a file and deletes the upload when a segment is unknown", async () => {
    const missing = await build(fakeDb().db);
    const noFile = await missing.app.inject({ method: "POST", url: "/contacts/imports", ...form([{ name: "on_conflict", value: "upsert" }]) });
    expect(noFile.statusCode).toBe(422);

    const unknown = await build(fakeDb({ segments: 0, topics: 0 }).db);
    const response = await unknown.app.inject({
      method: "POST",
      url: "/contacts/imports",
      ...form([
        { name: "segments", value: JSON.stringify(["segment_x"]) },
        { name: "file", filename: "c.csv", value: "email\na@example.com\n" },
      ]),
    });
    expect(response.statusCode).toBe(404);
    expect(unknown.storage.delete).toHaveBeenCalledTimes(1);
  });

  it("lists with a status filter and a default limit of 10, and reads one import", async () => {
    const { db, queries } = fakeDb();
    const { app } = await build(db);
    const list = await app.inject({ method: "GET", url: "/contacts/imports?status=completed" });
    expect(list.statusCode).toBe(200);
    const listQuery = queries.at(-1)!;
    expect(listQuery.sql).toContain("status = $2");
    expect(listQuery.params).toEqual(["tenant_1", "completed", 11]);
    expect(list.json().data[0].counts).toEqual({ total: 3, created: 2, updated: 0, skipped: 0, failed: 0 });

    const bad = await app.inject({ method: "GET", url: "/contacts/imports?status=done" });
    expect(bad.statusCode).toBe(400);

    const one = await app.inject({ method: "GET", url: "/contacts/imports/import_1" });
    expect(one.json()).toMatchObject({ object: "contact_import", id: "import_1", status: "completed" });
  });

  it("maps the multipart size error to a 413", () => {
    expect(uploadError(Object.assign(new Error("request file too large"), { code: "FST_REQ_FILE_TOO_LARGE" }))).toMatchObject({
      name: "validation_error",
      statusCode: 413,
    });
  });
});
