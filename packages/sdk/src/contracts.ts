// Serialized API responses. Presenters may supply Date values before JSON serialization.
export type BroadcastSummary<Timestamp = string> = {
  object: "broadcast";
  id: string;
  name: string;
  audience_id: string | null;
  segment_id: string | null;
  status: string;
  created_at: Timestamp;
  scheduled_at: Timestamp | null;
  sent_at: Timestamp | null;
};

export type Broadcast<Timestamp = string> = BroadcastSummary<Timestamp> & {
  from: string;
  subject: string | null;
  reply_to: string[] | null;
  preview_text: string | null;
  html: string | null;
  text: string | null;
  topic_id: string | null;
  paused: boolean;
  template_id: string | null;
  variables: Record<string, unknown>;
  recipient_count: number;
  sent_count: number;
  updated_at: Timestamp;
};

export type EmailRecipient = {
  id?: string;
  email: string;
  kind: "to" | "cc" | "bcc";
  status: string;
  sandbox: boolean;
  created_at?: string;
};

export type Tag = { name: string; value: string };

export type Email<Timestamp = string> = {
  object: "email";
  id: string;
  /** True only when every original recipient is sandbox; no email is sent externally. */
  sandbox: boolean;
  recipients: EmailRecipient[];
  message_id: string | null;
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  reply_to: string[];
  subject: string;
  html: string | null;
  text: string | null;
  last_event: string;
  scheduled_at: Timestamp | null;
  tags: Tag[];
  created_at: Timestamp;
};
