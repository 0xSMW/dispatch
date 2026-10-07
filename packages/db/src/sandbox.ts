// Explicit event attribution survives changes to delivery routing. Older events retain
// their email/recipient semantics until that attribution is recorded before reclassification.
export function realEmailEvent(event = "ev", email = "e") {
  return `(case when ${event}.data->>'sandbox' in ('true', 'false')
    then ${event}.data->>'sandbox' = 'false'
    else not coalesce(${email}.sandbox, false) and not exists (
      select 1 from email_recipients r
      where r.tenant_id = ${event}.tenant_id and r.id = ${event}.recipient_id and r.sandbox
    ) end)`;
}
