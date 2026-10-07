import { ApiError, stepConfigs, templateKind, type Step } from "@dispatchmail/core";
import type { Queryable } from "./index.js";

/** Shared by graph saves, activation, execution, and preset installation. */
export async function assertSendKinds(db: Queryable, tenantId: string, steps: Step[], enabled = false) {
  for (const step of steps) {
    if (step.type !== "send_email") continue;
    const config = stepConfigs.send_email.parse(step.config);
    if (config.kind === "marketing") {
      if (!config.topic_id) {
        if (enabled) throw new ApiError("validation_error", 422, `Marketing step ${step.key} needs a topic before it can run`);
      } else {
        const topic = await db.query(
          "select id from topics where tenant_id = $1 and id = $2 and deleted_at is null for share",
          [tenantId, config.topic_id],
        );
        if (!topic.rows[0]) throw new ApiError("validation_error", 422, `Marketing step ${step.key} needs an existing topic`);
      }
    }
    if (config.kind === "transactional") {
      // Inspect both the editable version and the version that delivery actually uses.
      const templates = await db.query<{ source: Record<string, unknown> | null; html: string | null; text: string | null }>(
        `select v.source, v.html, v.text from templates t
         join template_versions v on v.tenant_id = t.tenant_id and v.template_id = t.id
         where t.tenant_id = $1 and (t.id = $2 or t.alias = $2) and t.deleted_at is null
           and (v.id = t.published_version_id or v.id = (
             select latest.id from template_versions latest
             where latest.tenant_id = t.tenant_id and latest.template_id = t.id
             order by latest.created_at desc, latest.id desc limit 1))`,
        [tenantId, config.template.id],
      );
      if (templates.rows.some((template) => templateKind(template) === "marketing")) {
        throw new ApiError("validation_error", 422, `Step ${step.key} uses a Marketing template and must be Marketing`);
      }
    }
  }
}
