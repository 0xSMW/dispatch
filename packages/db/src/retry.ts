import { setTimeout } from "node:timers/promises";
import { tx, type Client, type Db } from "./index.js";

export function isDeadlock(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "40P01";
}

// Opt in only for complete database-only operations. PostgreSQL confirms 40P01
// aborted the transaction; tx has rolled back and released its client before retry.
// Transport/commit uncertainty and other errors must never replay an operation.
export async function retryTx<T>(db: Db, run: (client: Client) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await tx(db, run);
    } catch (error) {
      if (!isDeadlock(error) || attempt === 3) throw error;
      await setTimeout(10 * 2 ** attempt);
    }
  }
}
