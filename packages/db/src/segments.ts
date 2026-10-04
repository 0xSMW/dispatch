import {
  ApiError, durationSeconds, isIsoDate, operatorsForType, propertyTypes, ruleSchema,
  type PropertyType, type Rule, type RuleFieldType,
} from "@dispatchmail/core";

export type SegmentProperty = { key: string; type: PropertyType };
export type Bind = (value: unknown) => string;

const fields = new Map<string, RuleFieldType>([
  ["email", "string"], ["first_name", "string"], ["last_name", "string"],
  ["created_at", "date"], ["unsubscribed", "boolean"],
]);
const comparisons = { gt: ">", gte: ">=", lt: "<", lte: "<=" } as const;

function invalid(message: string): never {
  throw new ApiError("validation_error", 400, message);
}

// Check before recursive schema validation, including cyclic/untrusted inputs.
function limits(value: unknown) {
  const pending: Array<[unknown, number]> = [[value, 1]];
  let conditions = 0;
  while (pending.length) {
    const [node, depth] = pending.pop()!;
    if (depth > 5) invalid("Segment rules can nest at most 5 levels");
    if (node && typeof node === "object") {
      if ((node as { type?: unknown }).type === "rule" && ++conditions > 20) {
        invalid("Segment rules can hold at most 20 conditions");
      }
      const children = (node as { rules?: unknown }).rules;
      if (Array.isArray(children)) {
        if (children.length > 20) invalid("Segment rules can hold at most 20 conditions");
        for (const child of children) pending.push([child, depth + 1]);
      }
    }
  }
}

function number(raw: string) {
  const text = `btrim((${raw} #>> '{}'))`;
  // JSON numbers can exceed JavaScript's finite range in legacy/manual writes.
  // Bound the textual shape before casting; the inner CASE is an evaluation fence.
  const numeric = `(case when jsonb_typeof(${raw}) in ('number', 'string')
    and length(${text}) <= 400
    and ${text} ~ '^[+-]?([0-9]+(\\.[0-9]*)?|\\.[0-9]+)([eE][+-]?0*[0-9]{1,3})?$'
    then ${text}::numeric end)`;
  return `(case when ${numeric} between -1.7976931348623157e308::numeric and 1.7976931348623157e308::numeric then ${numeric} end)`;
}

function date(raw: string) {
  const text = `(${raw} #>> '{}')`;
  // Validate calendar days as well as shape. No user text is cast to a timestamp:
  // even a regex-shaped February 31, enormous fraction, or year zero is safe.
  const shape = `${text} ~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])(T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\\.[0-9]+)?(Z|[+-]([01][0-9]|2[0-3]):[0-5][0-9]))?$'`;
  const year = `substring(${text}, 1, 4)::integer`;
  const month = `substring(${text}, 6, 2)::integer`;
  const day = `substring(${text}, 9, 2)::integer`;
  const maxDay = `(case ${month} when 2 then case when ${year} % 4 = 0 and (${year} % 100 <> 0 or ${year} % 400 = 0) then 29 else 28 end when 4 then 30 when 6 then 30 when 9 then 30 when 11 then 30 else 31 end)`;
  const zone = `substring(${text} from '[+-][0-9]{2}:[0-9]{2}$')`;
  const zoneSeconds = `(case when ${zone} is null then 0 else
    (case when left(${zone}, 1) = '-' then -1 else 1 end) *
    (substring(${zone}, 2, 2)::integer * 3600 + substring(${zone}, 5, 2)::integer * 60) end)`;
  const timeSeconds = `(case when length(${text}) = 10 then 0 else
    substring(${text}, 12, 2)::integer * 3600 + substring(${text}, 15, 2)::integer * 60 +
    substring(${text}, 18, 2)::integer +
    coalesce(('0.' || left(substring(${text} from '\\.([0-9]+)'), 3))::numeric, 0) - ${zoneSeconds} end)`;
  return `(case when jsonb_typeof(${raw}) = 'string' and ${shape} then
    case when ${day} <= ${maxDay} then
      extract(epoch from (make_date(case when ${year} = 0 then -1 else ${year} end, ${month}, ${day})::timestamp at time zone 'UTC')) * 1000 +
      ${timeSeconds} * 1000
    end end)`;
}

function text(raw: string) {
  // Same string coercion as evaluate(), including legacy arrays and objects.
  // The recursive walk flattens array stringification, retaining empty items.
  return `(with recursive parts(value, path) as (
    select ${raw}, array[]::bigint[]
    union all
    select item.value, parts.path || item.ordinality
    from parts cross join lateral jsonb_array_elements(
      case when jsonb_typeof(parts.value) = 'array' then parts.value else '[]'::jsonb end
    ) with ordinality as item(value, ordinality)
  )
  select coalesce(string_agg(case
    when value is null or value = 'null'::jsonb or value = '[]'::jsonb then ''
    when jsonb_typeof(value) = 'object' then '[object Object]'
    else value #>> '{}' end, ',' order by path), '')
  from parts where jsonb_typeof(value) is distinct from 'array' or value = '[]'::jsonb)`;
}

function scalar(rule: Extract<Rule, { type: "rule" }>, raw: string, type: RuleFieldType, bind: Bind): string {
  const { operator, value } = rule;
  if (operator === "exists") return `(${raw} is not null and ${raw} <> 'null'::jsonb)`;
  if (operator === "is_empty") return `(${raw} is null or ${raw} in ('null'::jsonb, '""'::jsonb, '[]'::jsonb))`;
  if (operator === "eq" || operator === "neq") {
    const expected = value === undefined ? "null::jsonb" : `${bind(JSON.stringify(value))}::jsonb`;
    return `(${raw} is ${operator === "eq" ? "not " : ""}distinct from ${expected})`;
  }
  if (operator === "within" || operator === "not_within") {
    const seconds = bind(durationSeconds(value as string));
    const actual = date(raw);
    const now = "(extract(epoch from statement_timestamp()) * 1000)";
    const within = `(${actual} between ${now} - ${seconds}::numeric * 1000 and ${now})`;
    // Invalid/missing dates match neither operator.
    return `coalesce(${operator === "not_within" ? `not ${within}` : within}, false)`;
  }
  if (operator in comparisons) {
    const actual = type === "date" ? date(raw) : number(raw);
    const expected = bind(type === "date" ? Date.parse(value as string) : value);
    return `coalesce(${actual} ${comparisons[operator as keyof typeof comparisons]} ${expected}::numeric, false)`;
  }
  const expected = `${bind(value)}::text`;
  const actual = text(raw);
  if (operator === "starts_with") return `(left(${actual}, length(${expected})) = ${expected})`;
  if (operator === "ends_with") return `(right(${actual}, length(${expected})) = ${expected})`;
  // Literal substring matching, not LIKE, so '%' and '_' are not wildcards.
  const contains = `(case when jsonb_typeof(${raw}) = 'array' then ${raw} @> jsonb_build_array(${expected}) else strpos(${actual}, ${expected}) > 0 end)`;
  return operator === "not_contains" ? `(not ${contains})` : contains;
}

function membership(key: string, value: string | undefined) {
  if (key === "topics") {
    return `(c.unsubscribed_at is null and exists (
      select 1 from topics t
      left join topic_subscriptions s on s.tenant_id = t.tenant_id and s.topic_id = t.id and s.contact_id = c.id
      where t.tenant_id = c.tenant_id and t.deleted_at is null
        and coalesce(s.status, t.default_status) = 'subscribed'
        ${value ? `and t.id = ${value}::text` : ""}
    ))`;
  }
  return `exists (
    select 1 from segments s
    join segment_contacts m on m.tenant_id = s.tenant_id and m.segment_id = s.id and m.contact_id = c.id
    where s.tenant_id = c.tenant_id and s.deleted_at is null
      and to_jsonb(s)->>'rule' is null and coalesce(to_jsonb(s)->>'type', 'static') = 'static'
      ${value ? `and s.id = ${value}::text` : ""}
  )`;
}

/**
 * Pure SQL fragment over the fixed contacts alias c. The caller supplies declared
 * property metadata and owns bind placeholders, tenant/live-contact filtering and IO.
 * Engagement fields are deliberately unsupported until their shared contract exists.
 */
export function segmentPredicate(rule: Rule, bind: Bind, properties: readonly SegmentProperty[]): string {
  limits(rule);
  const parsed = ruleSchema.safeParse(rule);
  if (!parsed.success) invalid(parsed.error.issues[0]?.message ?? "Invalid segment rule");
  const definitions = new Map<string, PropertyType>();
  for (const property of properties) {
    if (!property.key || !propertyTypes.includes(property.type) || definitions.has(property.key)) {
      invalid("Invalid segment property metadata");
    }
    definitions.set(property.key, property.type);
  }

  // Resolve and validate every leaf before bind(), so refusal does not partly
  // mutate the caller's parameter collection.
  function validate(node: Rule) {
    if (node.type !== "rule") { node.rules.forEach(validate); return; }
    if (!node.field.startsWith("contact.") || node.field.slice(8).includes(".")) {
      invalid(`Unsupported segment field: ${node.field}`);
    }
    const key = node.field.slice(8);
    const type = fields.get(key) ?? definitions.get(key) ?? (key === "topics" || key === "segments" ? "set" : undefined);
    if (!type) invalid(`Unknown segment field: ${node.field}`);
    if (!operatorsForType(type).includes(node.operator)) invalid(`Operator ${node.operator} is not supported for ${node.field}`);
    if (node.operator === "exists" || node.operator === "is_empty") return;
    if (node.operator === "within" || node.operator === "not_within") return;
    if ((node.operator === "eq" || node.operator === "neq") && (node.value === null || node.value === undefined)) return;
    const valid = type === "date" ? isIsoDate(node.value)
      : type === "number" ? typeof node.value === "number" && Number.isFinite(node.value)
      : type === "boolean" ? typeof node.value === "boolean" : typeof node.value === "string";
    if (!valid) invalid(`Invalid value for ${node.field}`);
  }
  validate(parsed.data);

  function compile(node: Rule): string {
    if (node.type !== "rule") return `(${node.rules.map(compile).join(node.type === "and" ? " and " : " or ")})`;
    const key = node.field.slice(8);
    const builtin = fields.get(key);
    if (builtin) {
      const raw = key === "unsubscribed" ? "to_jsonb(c.unsubscribed_at is not null)"
        : key === "created_at" ? `to_jsonb(to_char(c.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))`
        : `coalesce(to_jsonb(c.${key}), 'null'::jsonb)`;
      return scalar(node, raw, builtin, bind);
    }
    const parameter = `${bind(key)}::text`;
    const raw = `(c.properties -> ${parameter})`;
    const type = definitions.get(key);
    if (key !== "topics" && key !== "segments") return scalar(node, raw, type!, bind);

    // Old own properties named topics/segments still win, even when undeclared.
    const own = scalar(node, raw, type ?? "set", bind);
    let fallback: string;
    if (node.operator === "exists") fallback = "true"; // Context always contains the set.
    else if (node.operator === "is_empty") fallback = `(not ${membership(key, undefined)})`;
    else if (node.operator === "contains" || node.operator === "not_contains") {
      const member = membership(key, bind(node.value));
      fallback = node.operator === "not_contains" ? `(not ${member})` : member;
    } else fallback = node.operator === "neq" ? "true" : "false"; // A set cannot equal/order a scalar.
    return `(case when c.properties ? ${parameter} then ${own} else ${fallback} end)`;
  }
  return compile(parsed.data);
}
