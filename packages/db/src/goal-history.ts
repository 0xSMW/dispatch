/**
 * Rewind current scalar state using the first recorded change on/after a receipt.
 * All fields from one request at one timestamp move together. No synthetic
 * snapshots or state entries are invented before retained history.
 * Immutable builtin created_at takes precedence over custom-key history.
 * Alias h is a grouped receipt (tenant_id,contact_id,created_at,request_id).
 */
export function goalState(side: "before" | "after") {
  const comparison = side === "before" ? ">=" : ">";
  return `((
    c.properties || jsonb_build_object('email',c.email,'first_name',c.first_name,'last_name',c.last_name,
      'created_at',to_char(c.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'unsubscribed',c.unsubscribed_at is not null)
  ) || coalesce((
    select jsonb_object_agg(rewind.field,rewind.from_value) from (
      select distinct on (ch.field) ch.field,ch.from_value
      from contact_changes ch
      where ch.tenant_id = h.tenant_id and ch.contact_id = h.contact_id
        and ch.field <> 'created_at'
        and ch.field not like 'topics.%' and ch.field not like 'segments.%'
        and (ch.created_at,ch.request_id) ${comparison} (h.created_at,h.request_id)
      order by ch.field,ch.created_at,ch.request_id,ch.id
    ) rewind
  ),'{}'::jsonb))`;
}
// Set history is incomplete in older removal paths; refuse rather than silently
// counting current membership as historical entry.
export function assertGoalHistoryFields(rule: import("@dispatchmail/core").Rule) {
  const pending = [rule];
  while (pending.length) {
    const node = pending.pop()!;
    if (node.type !== "rule") pending.push(...node.rules);
    else if (["contact.topics", "contact.segments"].includes(node.field))
      return false;
  }
  return true;
}
