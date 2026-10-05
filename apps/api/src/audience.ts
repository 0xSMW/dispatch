import {
  ApiError,
  contactSchema,
  contactTopicsSchema,
  contactUpdateSchema,
  type EventType,
  id,
  propertySchema,
  propertyUpdateSchema,
  segmentContactSchema,
  segmentSchema,
  segmentPreviewSchema,
  segmentUpdateSchema,
  subscriptionSchema,
  suppressionBatchAddSchema,
  suppressionBatchRemoveSchema,
  suppressionSchema,
  topicSchema,
  topicUpdateSchema,
} from "@dispatchmail/core";
import {
  addContactSegment,
  addSuppressions,
  assertPropertyValues,
  contactActivity,
  contactColumns,
  contactStats,
  contactTopics,
  createProperty,
  deleteContact,
  dispatchContactWrite,
  dispatchSegmentAdded,
  dispatchTopicChanges,
  emit,
  findBy,
  findContact,
  findSuppression,
  mergeProperties,
  paginate,
  presentActivity,
  presentContact,
  presentPage,
  presentProperty,
  presentSegment,
  presentSuppression,
  presentTopic,
  propertyDefinitions,
  removeContactSegment,
  removeSuppressions,
  assertSegmentRule,
  segmentColumns,
  segmentCount,
  segmentFilter,
  segmentMatch,
  segmentPreview,
  staticSegment,
  updateSegment,
  retryTx,
  setContactTopics,
  softDelete,
  subscriptionWire,
  topicDefaultStatus,
  tx,
  updateContact,
  updateProperty,
  upsertContact,
  type ContactRow,
  type Db,
  type PagingParams,
  type Queryable,
} from "@dispatchmail/db";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { contactWhere, suppressionWhere, type ContactQuery, type SuppressionQuery } from "./filters.js";
import { SegmentCounts } from "./segment-counts.js";

type PropertyRow = Parameters<typeof presentProperty>[0];
type TopicRow = Parameters<typeof presentTopic>[0];
type SegmentRow = Parameters<typeof presentSegment>[0];
export type SegmentPreviewResponse = { count: number; sample: ReturnType<typeof presentContact>[] };
type SuppressionRow = Parameters<typeof presentSuppression>[0];

type EmitChange = (
  request: FastifyRequest,
  type: EventType,
  resourceId: string,
  data: Record<string, unknown>,
) => Promise<unknown>;

export function registerAudience(
  app: FastifyInstance,
  deps: {
    db: Db;
    paging: (request: FastifyRequest) => PagingParams;
    emitChange: EmitChange;
    slug: (value: string) => string;
  },
) {
  const { db, paging, emitChange, slug } = deps;
  const counts = new SegmentCounts();
  const change = (client: Queryable, request: FastifyRequest, type: EventType, resourceId: string, data: Record<string, unknown>) =>
    emit(client, { tenantId: request.auth!.tenant_id, requestId: request.request_id, type, resourceId, data, key: `${resourceId}:${type}:${id("change")}` });

  app.post("/contacts", async (request) => {
    const input = contactSchema.parse(request.body);
    const tenantId = request.auth!.tenant_id;
    return retryTx(db, async (client) => {
      const definitions = await propertyDefinitions(client, tenantId);
      assertPropertyValues(input.properties, definitions);
      const contact = await upsertContact(client, tenantId, input);
      await dispatchContactWrite(client, tenantId, request.request_id, contact.before, contact, { created: contact.created || contact.revived });
      for (const segment of input.segments ?? []) {
        const member = await addContactSegment(client, tenantId, contact.id, segment.id);
        await dispatchSegmentAdded(client, tenantId, request.request_id, contact, segment.id, member.added);
      }
      if (input.topics?.length) {
        const topics = await setContactTopics(client, tenantId, contact.id, input.topics);
        await dispatchTopicChanges(client, tenantId, request.request_id, contact, topics);
        await change(client, request, "contact.topics.updated", contact.id, { id: contact.id, email: contact.email });
      }
      await change(client, request, contact.created || contact.revived ? "contact.created" : "contact.updated", contact.id, { id: contact.id, email: contact.email });
      return presentContact(contact, definitions);
    });
  });

  app.get("/contacts", async (request) => {
    const tenantId = request.auth!.tenant_id;
    const query = request.query as ContactQuery;
    const filters = contactWhere({ ...query, segment_id: undefined });
    if (query.segment_id) {
      const predicate = await segmentFilter(db, tenantId, query.segment_id, (value) => { filters.params.push(value); return `$${filters.params.length + 1}`; });
      filters.where = [filters.where, predicate].filter(Boolean).join(" and ");
    }
    const definitions = await propertyDefinitions(db, tenantId);
    const page = await paginate<ContactRow>(db, "contacts c", tenantId, paging(request), {
      select: contactColumns.split(", ").map((column) => `c.${column}`).join(", "),
      tenantCol: "c.tenant_id", createdCol: "c.created_at", idCol: "c.id",
      deletedCol: "c.deleted_at",
      where: filters.where,
      params: filters.params,
    });
    // Each row carries its segments, for the list's Segments column. One query for the page.
    const memberParams: unknown[] = [tenantId, page.data.map((row) => row.id)];
    const match = page.data.length ? await segmentMatch(db, tenantId, (value) => { memberParams.push(value); return `$${memberParams.length}`; }) : "false";
    const memberships = page.data.length
      ? await db.query<{ contact_id: string; id: string; name: string }>(
          `select c.id as contact_id, s.id, s.name
           from contacts c join segments s on s.tenant_id = c.tenant_id
           where c.tenant_id = $1 and c.id = any($2::text[]) and c.deleted_at is null and ${match}
           order by s.name`,
          memberParams,
        )
      : { rows: [] };
    const segments = new Map<string, Array<{ id: string; name: string }>>();
    for (const row of memberships.rows) {
      segments.set(row.contact_id, [...(segments.get(row.contact_id) ?? []), { id: row.id, name: row.name }]);
    }
    return presentPage(page, (row) => ({ ...presentContact(row, definitions), segments: segments.get(row.id) ?? [] }));
  });

  app.get("/contacts/stats", async (request) => {
    return contactStats(db, request.auth!.tenant_id);
  });

  app.get("/contacts/:id/activity", async (request) => {
    const contact = await findContact(db, request.auth!.tenant_id, (request.params as { id: string }).id);
    const page = await contactActivity(db, request.auth!.tenant_id, contact, paging(request));
    return presentPage(page, presentActivity);
  });

  app.get("/contacts/:id/segments", async (request) => {
    const contact = await findContact(db, request.auth!.tenant_id, (request.params as { id: string }).id);
    const params: unknown[] = [contact.id];
    const match = await segmentMatch(db, request.auth!.tenant_id, (value) => { params.push(value); return `$${params.length + 1}`; });
    // The cursor is the segment id a client sees in each row, so the list pages over segments.
    const page = await paginate(
      db,
      "segments s",
      request.auth!.tenant_id,
      paging(request),
      {
        tenantCol: "s.tenant_id",
        createdCol: "s.created_at",
        idCol: "s.id",
        deletedCol: "s.deleted_at",
        where: `exists (select 1 from contacts c where c.tenant_id = s.tenant_id and c.id = $2 and c.deleted_at is null and ${match})`,
        params,
        select: segmentColumns.split(", ").map((column) => `s.${column}`).join(", "),
      },
    );
    return presentPage(page as { object: "list"; has_more: boolean; data: SegmentRow[] }, presentSegment);
  });

  app.post("/contacts/:id/segments/:segment_id", async (request) => {
    const params = request.params as { id: string; segment_id: string };
    return retryTx(db, async (client) => {
      const tenantId = request.auth!.tenant_id;
      const contact = await findContact(client, tenantId, params.id, true);
      const member = await addContactSegment(client, tenantId, contact.id, params.segment_id);
      await dispatchSegmentAdded(client, tenantId, request.request_id, contact, params.segment_id, member.added);
      return { object: "segment", id: params.segment_id, contact_id: contact.id };
    });
  });

  app.delete("/contacts/:id/segments/:segment_id", async (request) => {
    const params = request.params as { id: string; segment_id: string };
    const contact = await findContact(db, request.auth!.tenant_id, params.id);
    await retryTx(db, (client) => removeContactSegment(client, request.auth!.tenant_id, contact.id, params.segment_id));
    return { object: "segment", id: params.segment_id, deleted: true };
  });

  app.get("/contacts/:id/topics", async (request) => {
    const contact = await findContact(db, request.auth!.tenant_id, (request.params as { id: string }).id);
    const topics = await contactTopics(db, request.auth!.tenant_id, contact.id);
    return { object: "list", has_more: false, data: topics };
  });

  app.patch("/contacts/:id/topics", async (request) => {
    const input = contactTopicsSchema.parse(request.body);
    return retryTx(db, async (client) => {
      const tenantId = request.auth!.tenant_id;
      const contact = await findContact(client, tenantId, (request.params as { id: string }).id, true);
      const topics = await setContactTopics(client, tenantId, contact.id, input.topics);
      await dispatchTopicChanges(client, tenantId, request.request_id, contact, topics);
      await change(client, request, "contact.topics.updated", contact.id, { id: contact.id, email: contact.email });
      return { object: "list", has_more: false, data: await contactTopics(client, tenantId, contact.id) };
    });
  });

  app.get("/contacts/:id", async (request) => {
    const tenantId = request.auth!.tenant_id;
    const contact = await findContact(db, tenantId, (request.params as { id: string }).id);
    return presentContact(contact, await propertyDefinitions(db, tenantId));
  });

  app.patch("/contacts/:id", async (request) => {
    const tenantId = request.auth!.tenant_id;
    const input = contactUpdateSchema.parse(request.body);
    return retryTx(db, async (client) => {
      const definitions = await propertyDefinitions(client, tenantId);
      assertPropertyValues(input.properties, definitions);
      const contact = await findContact(client, tenantId, (request.params as { id: string }).id, true);
      const properties = input.properties === undefined ? undefined : mergeProperties(contact.properties, input.properties);
      const updated = await updateContact(client, tenantId, contact.id, { ...input, properties });
      await dispatchContactWrite(client, tenantId, request.request_id, contact, updated);
      await change(client, request, "contact.updated", contact.id, { id: contact.id, email: updated.email });
      return presentContact(updated, definitions);
    });
  });

  app.delete("/contacts/:id", async (request) => {
    const contact = await findContact(db, request.auth!.tenant_id, (request.params as { id: string }).id);
    const removed = await tx(db, (client) => deleteContact(client, request.auth!.tenant_id, contact.id));
    if (!removed) throw new ApiError("not_found", 404, "Contact not found");
    await emitChange(request, "contact.deleted", contact.id, { id: contact.id });
    return { object: "contact", contact: contact.id, deleted: true };
  });

  app.post("/contact-properties", async (request) => {
    const input = propertySchema.parse(request.body);
    const row = await createProperty(db, request.auth!.tenant_id, input);
    return presentProperty(row);
  });

  app.get("/contact-properties", async (request) => {
    const page = await paginate<PropertyRow>(db, "contact_properties", request.auth!.tenant_id, paging(request), {
      select: "id, key, type, fallback_value, created_at, updated_at",
      deletedCol: "deleted_at",
    });
    return presentPage(page, presentProperty);
  });

  app.get("/contact-properties/:id", async (request) => {
    const row = await findBy<PropertyRow>(db, "contact_properties", request.auth!.tenant_id, (request.params as { id: string }).id, {
      select: "id, key, type, fallback_value, created_at, updated_at",
      deletedCol: "deleted_at",
      errorMessage: "Contact property not found",
    });
    return presentProperty(row);
  });

  app.patch("/contact-properties/:id", async (request) => {
    const input = propertyUpdateSchema.parse(request.body);
    if (input.fallback_value === undefined) {
      const row = await findBy<PropertyRow>(db, "contact_properties", request.auth!.tenant_id, (request.params as { id: string }).id, {
        select: "id, key, type, fallback_value, created_at, updated_at",
        deletedCol: "deleted_at",
        errorMessage: "Contact property not found",
      });
      return presentProperty(row);
    }
    const row = await updateProperty(db, request.auth!.tenant_id, (request.params as { id: string }).id, input.fallback_value);
    return presentProperty(row);
  });

  app.delete("/contact-properties/:id", async (request) => {
    const propertyId = (request.params as { id: string }).id;
    const removed = await softDelete(db, "contact_properties", request.auth!.tenant_id, propertyId);
    if (!removed.rowCount) throw new ApiError("not_found", 404, "Contact property not found");
    return { object: "contact_property", id: propertyId, deleted: true };
  });

  app.post("/topics", async (request) => {
    const input = topicSchema.parse(request.body);
    const row = await db.query(
      `insert into topics (id, tenant_id, name, key, description, visibility, default_status)
       values ($1, $2, $3, $4, $5, $6, $7)
       returning id, name, key, description, visibility, default_status, created_at, updated_at`,
      [
        id("topic"),
        request.auth!.tenant_id,
        input.name,
        input.key ?? slug(input.name),
        input.description ?? null,
        input.visibility,
        topicDefaultStatus(input),
      ],
    );
    await emitChange(request, "topic.created", row.rows[0].id, {
      id: row.rows[0].id,
      name: row.rows[0].name,
      key: row.rows[0].key,
    });
    return presentTopic(row.rows[0]);
  });

  app.get("/topics", async (request) => {
    const page = await paginate<TopicRow>(db, "topics", request.auth!.tenant_id, paging(request), {
      select: "id, name, key, description, visibility, default_status, created_at, updated_at",
      deletedCol: "deleted_at",
    });
    return presentPage(page, presentTopic);
  });

  app.get("/topics/:id/subscriptions", async (request) => {
    const topic = await findBy<{ id: string }>(db, "topics", request.auth!.tenant_id, (request.params as { id: string }).id, {
      deletedCol: "deleted_at",
      errorMessage: "Topic not found",
    });
    const page = await paginate<{ status: string } & Record<string, unknown>>(
      db,
      "topic_subscriptions s join contacts c on c.id = s.contact_id and c.deleted_at is null",
      request.auth!.tenant_id,
      paging(request),
      {
        tenantCol: "s.tenant_id",
        createdCol: "s.created_at",
        idCol: "s.id",
        where: "s.topic_id = $2",
        params: [topic.id],
        select: "s.id, s.status, s.created_at, s.updated_at, c.id as contact_id, c.email, c.first_name, c.last_name",
      },
    );
    return presentPage(page, (row) => ({ ...row, subscription: subscriptionWire(row.status) }));
  });

  app.post("/topics/:id/subscriptions", async (request) => {
    const input = subscriptionSchema.parse(request.body);
    return retryTx(db, async (client) => {
      const tenantId = request.auth!.tenant_id;
      const topic = await findBy<{ id: string }>(client, "topics", tenantId, (request.params as { id: string }).id, { deletedCol: "deleted_at", errorMessage: "Topic not found" });
      const contact = await upsertContact(client, tenantId, input.email);
      await dispatchContactWrite(client, tenantId, request.request_id, contact.before, contact, { created: contact.created || contact.revived });
      const topics = await setContactTopics(client, tenantId, contact.id, [{ id: topic.id, subscription: input.status }]);
      await dispatchTopicChanges(client, tenantId, request.request_id, contact, topics);
      await change(client, request, "contact.topics.updated", contact.id, { id: contact.id, topic_id: topic.id, status: topics[0]!.status });
      return { object: "subscription", ...topics[0]!.row, subscription: subscriptionWire(topics[0]!.status), email: contact.email };
    });
  });

  app.get("/topics/:id", async (request) => {
    const topic = await findBy<TopicRow>(db, "topics", request.auth!.tenant_id, (request.params as { id: string }).id, {
      select: "id, name, key, description, visibility, default_status, created_at, updated_at",
      deletedCol: "deleted_at",
      errorMessage: "Topic not found",
    });
    return presentTopic(topic);
  });

  app.patch("/topics/:id", async (request) => {
    const topicId = (request.params as { id: string }).id;
    const input = topicUpdateSchema.parse(request.body);
    const current = await findBy<{ name: string; key: string; description: string | null; visibility: string }>(
      db,
      "topics",
      request.auth!.tenant_id,
      topicId,
      {
        select: "id, name, key, description, visibility, default_status",
        deletedCol: "deleted_at",
        errorMessage: "Topic not found",
      },
    );
    const row = await db.query(
      `update topics set name = $3, key = $4, description = $5, visibility = $6, updated_at = now()
       where tenant_id = $1 and id = $2 and deleted_at is null
       returning id, name, key, description, visibility, default_status, created_at, updated_at`,
      [
        request.auth!.tenant_id,
        topicId,
        input.name ?? current.name,
        input.key ?? current.key,
        input.description === undefined ? current.description : input.description,
        input.visibility ?? current.visibility,
      ],
    );
    await emitChange(request, "topic.updated", topicId, { id: row.rows[0].id, name: row.rows[0].name, key: row.rows[0].key });
    return presentTopic(row.rows[0]);
  });

  app.delete("/topics/:id", async (request) => {
    const topicId = (request.params as { id: string }).id;
    const removed = await softDelete(db, "topics", request.auth!.tenant_id, topicId);
    if (!removed.rowCount) throw new ApiError("not_found", 404, "Topic not found");
    await emitChange(request, "topic.deleted", topicId, { id: topicId });
    return { object: "topic", id: topicId, deleted: true };
  });

  app.post("/segments", async (request) => {
    const input = segmentSchema.parse(request.body);
    return retryTx(db, async (client) => {
      if (input.rule) await assertSegmentRule(client, request.auth!.tenant_id, input.rule);
      const row = await client.query(
        `insert into segments (id, tenant_id, name, description, rule)
         values ($1, $2, $3, $4, $5::jsonb) returning ${segmentColumns}`,
        [id("segment"), request.auth!.tenant_id, input.name, input.description ?? null, JSON.stringify(input.rule ?? null)],
      );
      return presentSegment(row.rows[0]);
    });
  });

  app.post("/segments/preview", async (request) => {
    const input = segmentPreviewSchema.parse(request.body);
    const tenantId = request.auth!.tenant_id;
    const preview = await segmentPreview(db, tenantId, input.rule);
    const definitions = await propertyDefinitions(db, tenantId);
    return { count: preview.count, sample: preview.sample.map((row) => presentContact(row, definitions)) };
  });

  app.get("/segments", async (request) => {
    const page = await paginate<SegmentRow>(
      db,
      `segments s
       left join segment_contacts sc on sc.tenant_id = s.tenant_id and sc.segment_id = s.id and s.rule is null
       left join contacts c on c.tenant_id = s.tenant_id and c.id = sc.contact_id and c.deleted_at is null`,
      request.auth!.tenant_id,
      paging(request),
      {
        tenantCol: "s.tenant_id",
        deletedCol: "s.deleted_at",
        createdCol: "s.created_at",
        idCol: "s.id",
        groupBy: "s.id",
        select: "s.id, s.name, s.description, s.rule, s.created_at, s.updated_at, case when s.rule is null then count(c.id)::integer else null end as contacts",
      },
    );
    return presentPage(page, presentSegment);
  });

  app.get("/segments/:id/contacts", async (request) => {
    const tenantId = request.auth!.tenant_id;
    const segment = await findBy<{ id: string; rule: unknown }>(db, "segments", tenantId, (request.params as { id: string }).id, {
      select: "id, rule",
      deletedCol: "deleted_at",
      errorMessage: "Segment not found",
    });
    if (segment.rule != null) {
      const params: unknown[] = [];
      const predicate = await segmentFilter(db, tenantId, segment.id, (value) => { params.push(value); return `$${params.length + 1}`; });
      const page = await paginate(db, "contacts c", tenantId, paging(request), {
        tenantCol: "c.tenant_id", createdCol: "c.created_at", idCol: "c.id", deletedCol: "c.deleted_at",
        where: predicate, params,
        select: "c.id, c.id as contact_id, c.created_at, c.email, c.first_name, c.last_name",
      });
      return presentPage(page, (row) => ({ object: "contact" as const, ...row }));
    }
    const page = await paginate(
      db,
      "segment_contacts sc join contacts c on c.tenant_id = sc.tenant_id and c.id = sc.contact_id and c.deleted_at is null",
      request.auth!.tenant_id,
      paging(request),
      {
        tenantCol: "sc.tenant_id",
        createdCol: "sc.created_at",
        idCol: "sc.id",
        where: "sc.segment_id = $2",
        params: [segment.id],
        select: "sc.id, sc.created_at, c.id as contact_id, c.email, c.first_name, c.last_name",
      },
    );
    return presentPage(page, (row) => ({ object: "contact" as const, ...row }));
  });

  app.post("/segments/:id/contacts", async (request) => {
    const input = segmentContactSchema.parse(request.body);
    return retryTx(db, async (client) => {
      const tenantId = request.auth!.tenant_id;
      const segmentId = (request.params as { id: string }).id;
      const contact = await upsertContact(client, tenantId, input.email);
      const segment = await staticSegment(client, tenantId, segmentId);
      await dispatchContactWrite(client, tenantId, request.request_id, contact.before, contact, { created: contact.created || contact.revived });
      const { added, ...member } = await addContactSegment(client, tenantId, contact.id, segment.id);
      await dispatchSegmentAdded(client, tenantId, request.request_id, contact, segment.id, added);
      return { object: "contact", ...member, email: contact.email };
    });
  });

  app.delete("/segments/:id/contacts/:contact_id", async (request) => {
    const segment = await findBy<{ id: string }>(db, "segments", request.auth!.tenant_id, (request.params as { id: string }).id, {
      deletedCol: "deleted_at",
      errorMessage: "Segment not found",
    });
    const contactId = (request.params as { contact_id: string }).contact_id;
    const row = await retryTx(db, async (client) => {
      await staticSegment(client, request.auth!.tenant_id, segment.id);
      return client.query(
      `delete from segment_contacts
       where tenant_id = $1 and segment_id = $2 and (id = $3 or contact_id = $3)
       returning id`,
      [request.auth!.tenant_id, segment.id, contactId],
      );
    });
    if (!row.rows[0]) throw new ApiError("not_found", 404, "Segment contact not found");
    return { object: "contact", id: contactId, deleted: true };
  });

  app.get("/segments/:id", async (request) => {
    const segment = await findBy<SegmentRow>(db, "segments", request.auth!.tenant_id, (request.params as { id: string }).id, {
      select: segmentColumns,
      deletedCol: "deleted_at",
      errorMessage: "Segment not found",
    });
    const contacts = segment.rule == null
      ? await segmentCount(db, request.auth!.tenant_id, segment.id)
      : await counts.get(request.auth!.tenant_id, segment.id, String(segment.updated_at), () => segmentCount(db, request.auth!.tenant_id, segment.id));
    return presentSegment({ ...segment, contacts });
  });

  app.patch("/segments/:id", async (request) => {
    const segmentId = (request.params as { id: string }).id;
    const input = segmentUpdateSchema.parse(request.body);
    const row = await retryTx(db, (client) => updateSegment(client, request.auth!.tenant_id, segmentId, input));
    counts.invalidate(request.auth!.tenant_id, segmentId);
    return presentSegment(row);
  });

  app.delete("/segments/:id", async (request) => {
    const segmentId = (request.params as { id: string }).id;
    const removed = await softDelete(db, "segments", request.auth!.tenant_id, segmentId);
    if (!removed.rowCount) throw new ApiError("not_found", 404, "Segment not found");
    counts.invalidate(request.auth!.tenant_id, segmentId);
    return { object: "segment", id: segmentId, deleted: true };
  });

  app.post("/suppressions/batch/add", async (request) => {
    const input = suppressionBatchAddSchema.parse(request.body);
    const rows = await addSuppressions(db, request.auth!.tenant_id, input.emails);
    for (const row of rows) {
      await emitChange(request, "suppression.added", row.id, { id: row.id, email: row.email, origin: "manual" });
    }
    return { object: "list", has_more: false, data: rows.map(presentSuppression) };
  });

  app.post("/suppressions/batch/remove", async (request) => {
    const input = suppressionBatchRemoveSchema.parse(request.body);
    const rows = await removeSuppressions(db, request.auth!.tenant_id, input);
    for (const row of rows) {
      await emitChange(request, "suppression.removed", row.id, { id: row.id, email: row.email });
    }
    return { object: "list", has_more: false, data: rows.map((row) => ({ object: "suppression" as const, id: row.id, email: row.email, deleted: true })) };
  });

  app.post("/suppressions", async (request) => {
    const input = suppressionSchema.parse(request.body);
    const rows = await addSuppressions(db, request.auth!.tenant_id, [input.email], input.reason);
    const row = rows[0];
    await emitChange(request, "suppression.added", row.id, { id: row.id, email: row.email, origin: row.origin });
    return presentSuppression(row);
  });

  app.get("/suppressions", async (request) => {
    const filters = suppressionWhere(request.query as SuppressionQuery);
    const page = await paginate<SuppressionRow>(db, "suppressions", request.auth!.tenant_id, paging(request), {
      select: "id, email, reason, origin, source_id, created_at",
      where: filters.where,
      params: filters.params,
    });
    return presentPage(page, presentSuppression);
  });

  app.get("/suppressions/:id", async (request) => {
    const row = await findSuppression(db, request.auth!.tenant_id, (request.params as { id: string }).id);
    return presentSuppression(row);
  });

  app.delete("/suppressions/:id", async (request) => {
    const ref = (request.params as { id: string }).id;
    const current = await findSuppression(db, request.auth!.tenant_id, ref);
    const rows = await removeSuppressions(db, request.auth!.tenant_id, ref.includes("@") ? { emails: [current.email] } : { ids: [current.id] });
    if (!rows[0]) throw new ApiError("not_found", 404, "Suppression not found");
    await emitChange(request, "suppression.removed", current.id, { id: current.id, email: current.email });
    return { object: "suppression", id: current.id, deleted: true };
  });
}
