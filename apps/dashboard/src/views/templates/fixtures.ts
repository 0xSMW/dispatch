// Response fixtures for the template and broadcast page tests.
import type { BroadcastDetail, Template, TemplateVersion } from "../../types";

export function template(fields: Partial<Template> = {}): Template {
  return {
    object: "template",
    id: "tpl_1",
    name: "Welcome",
    alias: "welcome",
    from: "Acme <hello@acme.test>",
    reply_to: [],
    subject: "Welcome, {{{NAME}}}",
    html: "<p>Hi {{{NAME}}}, your plan is {{{PLAN}}}.</p>",
    text: null,
    variables: [
      { key: "NAME", type: "string", fallback_value: null },
      { key: "PLAN", type: "string", fallback_value: "Free" },
    ],
    status: "published",
    published_at: "2026-09-30T10:00:00.000Z",
    published_version_id: "version_1",
    current_version_id: "version_2",
    has_unpublished_versions: true,
    track: true,
    created_at: "2026-09-29T10:00:00.000Z",
    updated_at: "2026-09-30T11:00:00.000Z",
    ...fields,
  };
}

export function version(fields: Partial<TemplateVersion> = {}): TemplateVersion {
  return {
    id: "version_1",
    from: "Acme <hello@acme.test>",
    reply_to: [],
    subject: "Welcome",
    html: "<p>Hi</p>",
    text: null,
    variables: [],
    created_at: "2026-09-29T10:00:00.000Z",
    published_at: null,
    ...fields,
  };
}

export function broadcast(fields: Partial<BroadcastDetail> = {}): BroadcastDetail {
  return {
    object: "broadcast",
    id: "broadcast_1",
    name: "October update",
    from: "Acme <news@acme.test>",
    reply_to: undefined,
    subject: "What is new",
    preview_text: null,
    html: '<p>Hi {{{contact.first_name|there}}}</p><a href="https://acme.test/new">Read</a>',
    text: null,
    topic_id: null,
    segment_id: "seg_1",
    status: "draft",
    paused: false,
    template_id: null,
    recipient_count: 0,
    sent_count: 0,
    created_at: "2026-09-30T10:00:00.000Z",
    scheduled_at: null,
    sent_at: null,
    ...fields,
  };
}

export const segment = { object: "segment", id: "seg_1", name: "Customers", contacts: 120, created_at: "2026-09-01T00:00:00.000Z", updated_at: "2026-09-01T00:00:00.000Z" };
export const topic = {
  object: "topic",
  id: "topic_1",
  name: "Product news",
  key: "news",
  description: null,
  visibility: "public",
  default_subscription: "opt_in",
  created_at: "2026-09-01T00:00:00.000Z",
  updated_at: "2026-09-01T00:00:00.000Z",
};
