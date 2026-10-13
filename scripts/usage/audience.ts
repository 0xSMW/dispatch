import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Usage } from "./common.js";

export async function audience(u: Usage): Promise<void> {
  u.check((await u.api("GET", "/health")).provider === "fake", "Audience requires the fake provider");
  const name = `${u.run.slice(-32)} audience`;
  const addresses = ["ada", "bea", "cy"].map((person) => `${u.run}-${person}@usage.invalid`);
  async function create(path: string, body: unknown) {
    const row = await u.api("POST", path, body);
    u.check(typeof row.id === "string" && row.id.length, `${path} did not return an ID`);
    if (path !== "/broadcasts") u.clean(`${path}/${row.id}`);
    return row;
  }
  const topic = await create("/topics", { name, key: `${u.run}-audience`, default_subscription: "opt_out" });
  const segment = await create("/segments", { name });
  const csv = join(u.dir, "audience.csv");
  await writeFile(csv, ["email,first_name,unsubscribed", `${addresses[0]},Ada,false`,
    `${addresses[1]},Bea,false`, `${addresses[2]},Cy,true`, ""].join("\n"), { flag: "wx", mode: 0o600 });
  const imported = await u.form("/contacts/imports", {
    file: `@${csv};type=text/csv`, segments: JSON.stringify([segment.id]),
    topics: JSON.stringify([{ id: topic.id, subscription: "opt_in" }]), trigger_automations: "false",
  });
  u.check(typeof imported.id === "string" && imported.id.length && !imported.trigger_automations,
    "Import did not return an owned job with automations disabled");
  const result = await u.wait(() => u.api("GET", `/contacts/imports/${imported.id}`),
    (row) => ["completed", "failed", "cancelled"].includes(row.status), "audience CSV import");
  u.check(result.status === "completed" && result.counts.total === 3 && result.counts.created === 3
    && result.counts.updated === 0 && result.counts.skipped === 0 && result.counts.failed === 0,
    "Audience import did not create exactly three contacts");
  const [storedImport] = await u.sql(`select status,counts,row_offset,trigger_automations from contact_imports
    where tenant_id=$1 and id=$2`, [u.tenant, imported.id]);
  u.check(storedImport?.status === "completed" && storedImport.row_offset === 3 && !storedImport.trigger_automations
    && storedImport.counts.total === 3 && storedImport.counts.created === 3
    && storedImport.counts.updated === 0 && storedImport.counts.skipped === 0
    && storedImport.counts.failed === 0, "Persisted import differs from its completed API result");
  const contacts = (await u.api("GET", `/contacts?segment_id=${segment.id}&limit=100`)).data;
  u.check(contacts.length === 3 && addresses.every((email) => contacts.some((row: any) => row.email === email)),
    "Imported static membership differs from the CSV");
  for (const contact of contacts) u.clean(`/contacts/${contact.id}`);
  const ada = contacts.find((row: any) => row.email === addresses[0]);
  const bea = contacts.find((row: any) => row.email === addresses[1]);
  u.check(contacts.find((row: any) => row.email === addresses[2]).unsubscribed, "CSV global opt-out was lost");
  const broadcast = await create("/broadcasts", {
    name, from: u.sender, subject: `${u.run} audience broadcast`, segment_id: segment.id, topic_id: topic.id,
    html: '<p>Hello {{{FIRST_NAME}}}</p><a href="{{{UNSUBSCRIBE_URL}}}">Unsubscribe</a>',
  });
  await u.api("PATCH", `/contacts/${bea.id}/topics`, { topics: [{ id: topic.id, subscription: "opt_out" }] });
  const optedOut = await u.api("GET", `/broadcasts/${broadcast.id}/audience`);
  u.check(optedOut.total === 3 && optedOut.recipients === 1 && optedOut.opted_out === 1
    && optedOut.unsubscribed === 1 && optedOut.suppressed === 0, "Topic consent did not exclude Bea");
  await u.api("PATCH", `/contacts/${bea.id}/topics`, { topics: [{ id: topic.id, subscription: "opt_in" }] });
  await create("/suppressions", { email: addresses[1], reason: `${u.run} audience` });
  const eligible = await u.api("GET", `/broadcasts/${broadcast.id}/audience`);
  u.check(eligible.total === 3 && eligible.recipients === 1 && eligible.suppressed === 1
    && eligible.unsubscribed === 1 && eligible.opted_out === 0, "Suppression did not leave only Ada eligible");
  const persisted = await u.sql(`select c.email, c.unsubscribed_at, s.status as subscription,
      exists(select 1 from segment_contacts m where m.tenant_id=c.tenant_id and m.contact_id=c.id
        and m.segment_id=$3) as member
    from contacts c join topic_subscriptions s on s.tenant_id=c.tenant_id and s.contact_id=c.id
      and s.topic_id=$2 where c.tenant_id=$1 and c.email=any($4::text[])`,
    [u.tenant, topic.id, segment.id, addresses]);
  u.check(persisted.length === 3 && persisted.every((row) => row.member && row.subscription === "subscribed")
    && persisted.every((row) => Boolean(row.unsubscribed_at) === (row.email === addresses[2])),
    "Stored membership or consent differs");

  await u.api("POST", `/broadcasts/${broadcast.id}/send`, {});
  const sent = await u.wait(() => u.api("GET", `/broadcasts/${broadcast.id}`),
    (row) => ["sent", "failed", "canceled"].includes(row.status), "audience broadcast");
  u.check(sent.status === "sent" && sent.recipient_count === 1, "Broadcast did not select one recipient");
  const template = await create("/templates", {
    name, from: u.sender, subject: `${u.run} audience automation`, text: "Hello {{{NAME}}}",
    variables: ["NAME"], publish: true,
  });
  const eventName = `${u.run}.audience`;
  await create("/events", { name: eventName, schema: { score: "number" } });
  const automation = await create("/automations", {
    name, enabled: true, steps: [
      { key: "trigger", type: "trigger", config: { type: "event", event_name: eventName } },
      { key: "send", type: "send_email", config: { kind: "transactional", from: u.sender,
        template: template.id, variable_mapping: { NAME: "contact.first_name" } } },
    ], connections: [{ from: "trigger", to: "send", type: "default" }],
  });
  const event = await u.api("POST", "/events/send", { event: eventName, contact_id: ada.id, payload: { score: 42 } }, 202);
  const runs = await u.wait(() => u.api("GET", `/automations/${automation.id}/runs`),
    (page) => page.data.length > 0 && page.data.every((row: any) => ["completed", "failed"].includes(row.status)),
    "audience automation");
  u.check(runs.data.length === 1 && runs.data[0].status === "completed"
    && runs.data[0].event.id === event.id, "Contact event did not complete exactly one automation run");
  const run = await u.api("GET", `/automations/${automation.id}/runs/${runs.data[0].id}`);
  u.check(run.steps.length === 1 && run.steps[0].status === "completed", "Automation send step did not complete");
  const deliveries = await u.wait(() => u.sql(`select e.id,e.broadcast_id,e.automation_id,e.text,e.sandbox,
      e.status,r.email,r.status as recipient_status,j.state,j.error,
      (select count(*)::int from email_events v where v.tenant_id=e.tenant_id and v.email_id=e.id
        and v.type='email.delivered' and v.data->>'sandbox'='true') as delivered_events
    from emails e left join email_recipients r on r.tenant_id=e.tenant_id and r.email_id=e.id
      left join send_jobs j on j.tenant_id=e.tenant_id and j.email_id=e.id
    where e.tenant_id=$1 and (e.broadcast_id=$2 or e.automation_id=$3)`, [u.tenant, broadcast.id, automation.id]),
    (rows) => rows.length === 2 && rows.every((row: any) => row.state === "done" && row.status === "delivered"
      && row.recipient_status === "delivered" && row.delivered_events === 1), "audience delivery jobs and events");
  u.check(deliveries.every((row: any) => row.email === addresses[0] && row.sandbox && !row.error)
    && deliveries.some((row: any) => row.broadcast_id === broadcast.id)
    && deliveries.some((row: any) => row.automation_id === automation.id && row.text === "Hello Ada"),
    "Delivered records differ from the selected audience or mapped template");
  const recipients = await u.api("GET", `/broadcasts/${broadcast.id}/recipients?type=delivered`);
  u.check(recipients.data.length === 1 && recipients.data[0].email === addresses[0], "Delivered audience differs");
  const excluded = await u.sql(`select count(*)::int as count from send_jobs j
    join email_recipients r on r.tenant_id=j.tenant_id and r.email_id=j.email_id
    where j.tenant_id=$1 and r.email=any($2::text[])`, [u.tenant, addresses.slice(1)]);
  u.check(excluded[0].count === 0, "An excluded audience contact received a send job");
}
