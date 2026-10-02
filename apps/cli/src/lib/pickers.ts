import type { Api } from "./client.js";
import { pick } from "./prompts.js";
import type { Globals } from "./tty.js";

type Row = { id: string } & Record<string, any>;

function picker(noun: string, list: (api: Api) => ReturnType<Api["domains"]["list"]>, label: (item: Row) => string) {
  return (id: string | undefined, globals: Globals) => pick<Row>(id, { globals, noun, list, label });
}

const page = { limit: 100 };

export const pickDomain = picker(
  "domain",
  (api) => api.domains.list(page),
  (row) => row.name,
);
export const pickApiKey = picker(
  "API key",
  (api) => api.apiKeys.list(page),
  (row) => row.name,
);
export const pickWebhook = picker(
  "webhook",
  (api) => api.webhooks.list(page),
  (row) => row.endpoint ?? row.url,
);
export const pickEmail = picker(
  "email",
  (api) => api.emails.list(page),
  (row) => `${row.subject ?? ""} → ${[row.to].flat().join(", ")}`,
);
export const pickReceived = picker(
  "received email",
  (api) => api.emails.receiving.list(page),
  (row) => `${row.subject ?? ""} ← ${row.from}`,
);
export const pickTemplate = picker(
  "template",
  (api) => api.templates.list(page),
  (row) => row.alias ?? row.name,
);
export const pickContact = picker(
  "contact",
  (api) => api.contacts.list(page),
  (row) => row.email,
);
export const pickProperty = picker(
  "contact property",
  (api) => api.contactProperties.list(page),
  (row) => row.key,
);
export const pickSegment = picker(
  "segment",
  (api) => api.segments.list(page),
  (row) => row.name,
);
export const pickTopic = picker(
  "topic",
  (api) => api.topics.list(page),
  (row) => row.name,
);
export const pickSuppression = picker(
  "suppression",
  (api) => api.suppressions.list(page),
  (row) => row.email,
);
export const pickBroadcast = picker(
  "broadcast",
  (api) => api.broadcasts.list(page),
  (row) => row.name ?? row.subject,
);
export const pickAutomation = picker(
  "automation",
  (api) => api.automations.list(page),
  (row) => row.name,
);
export const pickEvent = picker(
  "event",
  (api) => api.events.list(page),
  (row) => row.name,
);
export const pickLog = picker(
  "log",
  (api) => api.logs.list(page),
  (row) => `${row.method} ${row.endpoint ?? row.path} ${row.response_status ?? row.status}`,
);
