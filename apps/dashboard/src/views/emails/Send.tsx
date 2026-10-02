import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { Code } from "../../components/Code";
import { Empty } from "../../components/Empty";
import { Field, TextArea } from "../../components/Field";
import { PageHeader } from "../../components/PageHeader";
import { Panel } from "../../components/Panel";
import { Tabs } from "../../components/Tabs";
import { useMutation } from "../../hooks/useMutation";
import { csv, sendBody } from "../../lib/utils";
import { usable, useWhen, whenHint } from "../../lib/when";
import { useCan, useClient } from "../../shell/session";
import { emailTabs } from "../tabs";

const blankEmail = { from: "", to: "", cc: "", bcc: "", subject: "", text: "", html: "", headers: "", tags: "", scheduled_at: "" };
const blankBatch = { from: "", to: "", subject: "", text: "" };

/** Compose a test send. Dispatch-only; Resend has no equivalent page. */
export function Send() {
  const client = useClient();
  const can = useCan();
  const [form, setForm] = useState(blankEmail);
  const [batch, setBatch] = useState(blankBatch);
  const set = (key: keyof typeof blankEmail) => (value: string) => setForm({ ...form, [key]: value });
  const setB = (key: keyof typeof blankBatch) => (value: string) => setBatch({ ...batch, [key]: value });

  // A schedule is read in the browser's zone and sent as an exact instant.
  const schedule = useWhen(form.scheduled_at);
  const scheduled = form.scheduled_at.trim() !== "";
  const send = useMutation(
    () => client.post<{ id: string }>("/emails", sendBody({ ...form, scheduled_at: scheduled && schedule.when ? schedule.when.date.toISOString() : "" })),
    { success: scheduled ? "Email scheduled." : "Email queued." },
  );
  const sendBatch = useMutation(
    () => {
      const recipients = csv(batch.to);
      return client.post(
        "/emails/batch",
        recipients.map((to, index) => ({
          from: batch.from,
          to,
          subject: recipients.length === 1 ? batch.subject : `${batch.subject} ${index + 1}`,
          text: batch.text,
        })),
      );
    },
    { success: "Batch queued." },
  );

  const submit = (run: () => void) => (event: FormEvent) => {
    event.preventDefault();
    run();
  };

  if (!can) {
    return (
      <div className="page">
        <PageHeader title="Emails" />
        <Tabs tabs={emailTabs} />
        <Empty title="Read access" body="Your role can read emails but not send them. Ask an admin for full access." />
      </div>
    );
  }

  return (
    <div className="page">
      <PageHeader title="Emails" />
      <Tabs tabs={emailTabs} />
      <div className="columns">
        <Panel title="Send an email">
          <form className="form two" onSubmit={submit(() => void send.mutate())}>
            <Field label="From" value={form.from} onChange={set("from")} placeholder="Acme <hello@yourdomain.com>" required />
            <Field label="To" value={form.to} onChange={set("to")} placeholder="you@example.com" required hint="Separate addresses with commas." />
            <Field label="CC" value={form.cc} onChange={set("cc")} />
            <Field label="BCC" value={form.bcc} onChange={set("bcc")} />
            <Field label="Subject" value={form.subject} onChange={set("subject")} required wide />
            <TextArea label="Text" value={form.text} onChange={set("text")} wide />
            <TextArea label="HTML" value={form.html} onChange={set("html")} mono wide />
            <TextArea label="Headers JSON" value={form.headers} onChange={set("headers")} placeholder="{}" mono rows={3} />
            <TextArea label="Tags JSON" value={form.tags} onChange={set("tags")} placeholder='[{"name":"category","value":"test"}]' mono rows={3} />
            <Field
              label="Scheduled at"
              value={form.scheduled_at}
              onChange={set("scheduled_at")}
              placeholder="in 10 minutes"
              hint={scheduled ? whenHint(form.scheduled_at, schedule) : "Leave empty to send now."}
              wide
            />
            <div className="wide toolbar">
              <button type="submit" disabled={send.isLoading || (scheduled && !usable(schedule))}>
                Send email
              </button>
            </div>
          </form>
          {send.data ? (
            <p className="muted">
              Queued as <Link to={`/emails/${send.data.id}`}>{send.data.id}</Link>.
            </p>
          ) : null}
        </Panel>

        <Panel title="Batch send">
          <form className="form" onSubmit={submit(() => void sendBatch.mutate())}>
            <Field label="From" value={batch.from} onChange={setB("from")} placeholder="hello@yourdomain.com" required />
            <Field label="To" value={batch.to} onChange={setB("to")} hint="One email per address, separated by commas." required />
            <Field label="Subject" value={batch.subject} onChange={setB("subject")} required />
            <TextArea label="Text" value={batch.text} onChange={setB("text")} required />
            <div className="toolbar">
              <button type="submit" disabled={sendBatch.isLoading}>
                Send batch
              </button>
            </div>
          </form>
          <Code value={sendBatch.data} />
        </Panel>
      </div>
    </div>
  );
}
