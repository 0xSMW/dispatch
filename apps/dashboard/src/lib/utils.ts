export function csv(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function parseJson<T>(value: string, fallback: T): T {
  if (!value || !value.trim()) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function shortJson(value: unknown): string {
  const text = JSON.stringify(value ?? {});
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

/** Splits on commas and line breaks, for address textareas. */
export function addresses(value: string): string[] {
  return value
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function fullName(row: { first_name?: string | null; last_name?: string | null }): string {
  return [row.first_name, row.last_name].filter(Boolean).join(" ");
}

export function emptyBody(form: Record<string, string>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(form)) {
    if (value.trim()) body[key] = value;
  }
  return body;
}

export function sendBody(form: Record<string, string>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(form)) {
    if (!value.trim()) continue;
    if (key === "headers" || key === "tags") {
      body[key] = parseJson(value, {});
    } else if (key === "to" || key === "cc" || key === "bcc") {
      body[key] = csv(value);
    } else {
      body[key] = value;
    }
  }
  return body;
}

export function inboundBody(form: Record<string, string>): Record<string, unknown> {
  const body: Record<string, unknown> = {
    ...emptyBody(form),
    to: csv(form.to),
    headers: parseJson(form.headers, {}),
  };
  const cc = csv(form.cc);
  const bcc = csv(form.bcc);
  if (cc.length) body.cc = cc;
  if (bcc.length) body.bcc = bcc;
  return body;
}
