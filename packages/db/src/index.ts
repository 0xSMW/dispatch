import pg from "pg";

const { Pool } = pg;

export type Db = pg.Pool;
export type Client = pg.PoolClient;

export function connect(databaseUrl = process.env.DATABASE_URL ?? "postgres://dispatch:dispatch@localhost:5432/dispatch") {
  return new Pool({
    connectionString: databaseUrl,
    max: Number(process.env.DB_POOL_SIZE ?? 20),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000
  });
}

export async function tx<T>(db: Db, run: (client: Client) => Promise<T>) {
  const client = await db.connect();
  try {
    await client.query("begin");
    const result = await run(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
