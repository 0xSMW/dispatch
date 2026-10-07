import { ApiError, automationRuleSchema, segmentRuleSchema, type Rule, type Step } from "@dispatchmail/core";
import type { Queryable } from "./index.js";
import { assertSegmentRule } from "./segments.js";

export const segmentColumns = "id, name, description, rule, created_at, updated_at";
export type SegmentRow = { id: string; name: string; description: string | null; rule: Rule | null; created_at: string; updated_at: string };

/** Caller owns the transaction; share one row lock with conversion and bulk imports. */
export async function staticSegment(db: Queryable, tenantId: string, segmentId: string) {
  const rows = await db.query<{ id: string; rule: Rule | null }>(
    "select id, rule from segments where tenant_id = $1 and id = $2 and deleted_at is null for update", [tenantId, segmentId],
  );
  if (!rows.rows[0]) throw new ApiError("not_found", 404, "Segment not found");
  if (rows.rows[0].rule != null) throw new ApiError("conflict", 409, "Dynamic segments do not accept membership writes");
  return rows.rows[0];
}

export async function assertSegmentSteps(db: Queryable, tenantId: string, steps: Step[]) {
  for (const step of steps) {
    const config = step.config as Record<string, unknown>;
    const rules = step.type === "condition" ? [step.config]
      : step.type === "filter" ? [config.rule]
      : step.type === "branch" ? (config.paths as Array<{ rule: Rule }>).map((path) => path.rule)
      : step.type === "wait_for_event" && config.filter_rule ? [config.filter_rule] : [];
    for (const rule of rules) {
      const parsed = automationRuleSchema.safeParse(rule);
      if (!parsed.success) throw new ApiError("validation_error", 422, parsed.error.issues[0]?.message ?? "Invalid automation rule");
    }
  }
  const ids = [...new Set(steps.filter((step) => step.type === "add_to_segment").map((step) => (step.config as { segment_id: string }).segment_id))].sort();
  for (const id of ids) await staticSegment(db, tenantId, id);
}

export async function updateSegment(db: Queryable, tenantId: string, segmentId: string, input: { name?: string; description?: string; rule?: Rule | null }): Promise<SegmentRow> {
  const rows = await db.query<SegmentRow>(
    `select ${segmentColumns} from segments where tenant_id = $1 and id = $2 and deleted_at is null for update`, [tenantId, segmentId],
  );
  const current = rows.rows[0];
  if (!current) throw new ApiError("not_found", 404, "Segment not found");
  if (input.rule != null) {
    const parsed = segmentRuleSchema.safeParse(input.rule);
    if (!parsed.success) throw new ApiError("validation_error", 400, parsed.error.issues[0]?.message ?? "Invalid filter");
    const selfReference = (node: Rule): boolean => node.type === "rule"
      ? node.field === "contact.segments" && node.value === segmentId
      : node.rules.some(selfReference);
    if (selfReference(input.rule)) throw new ApiError("conflict", 409, "A dynamic segment cannot depend on itself");
    if (current.rule == null) {
      const members = await db.query("select 1 from segment_contacts where tenant_id = $1 and segment_id = $2 limit 1", [tenantId, segmentId]);
      if (members.rows.length) throw new ApiError("conflict", 409, "Remove all static members before converting to a filter");
      const dependencies = await db.query(
        `select id from segments where tenant_id = $1 and deleted_at is null and rule is not null
         and jsonb_path_exists(rule, '$.** ? (@.field == "contact.segments" && @.value == $segment)', jsonb_build_object('segment', $2::text)) limit 1`,
        [tenantId, segmentId],
      );
      if (dependencies.rows.length) throw new ApiError("conflict", 409, "A filter depends on this static segment");
    }
    await assertSegmentRule(db, tenantId, input.rule);
  }
  if (input.rule === null && current.rule != null)
    await db.query("delete from segment_contacts where tenant_id = $1 and segment_id = $2", [tenantId, segmentId]);
  const nextRule = input.rule === undefined ? current.rule : input.rule;
  const updated = await db.query<SegmentRow>(
    `update segments set name = $3, description = $4, rule = $5::jsonb, updated_at = clock_timestamp()
     where tenant_id = $1 and id = $2 and deleted_at is null returning ${segmentColumns}`,
    [tenantId, segmentId, input.name ?? current.name, input.description ?? current.description,
      nextRule == null ? null : JSON.stringify(nextRule)],
  );
  return updated.rows[0]!;
}
