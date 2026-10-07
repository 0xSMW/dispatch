import { ApiError, settingsSchema, settingsUpdateSchema, type Settings } from "@dispatchmail/core";
import type { Queryable } from "./index.js";

export async function settings(db: Queryable, tenantId: string): Promise<Settings> {
  const result = await db.query<{ settings: unknown }>(
    "select settings from tenants where id = $1", [tenantId],
  );
  if (!result.rows[0]) throw new ApiError("not_found", 404, "Tenant not found");
  return settingsSchema.parse(result.rows[0].settings);
}

export async function updateSettings(db: Queryable, tenantId: string, input: unknown): Promise<Settings> {
  const patch = settingsUpdateSchema.parse(input);
  const result = await db.query<{ settings: unknown }>(
    "update tenants set settings = settings || $2::jsonb where id = $1 returning settings",
    [tenantId, JSON.stringify(patch)],
  );
  if (!result.rows[0]) throw new ApiError("not_found", 404, "Tenant not found");
  return settingsSchema.parse(result.rows[0].settings);
}
