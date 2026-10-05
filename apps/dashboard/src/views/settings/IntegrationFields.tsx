import { Field, Select, Switch } from "../../components/Field";
import type { Integration, IntegrationInput, IntegrationUpdate } from "../../types";

export const providers = [
  { value: "stripe", label: "Stripe" },
  { value: "clerk", label: "Clerk" },
  { value: "supabase", label: "Supabase" },
  { value: "webhook", label: "Standard Webhooks" },
];

// Deliberately browser-local: provider adapters contain server-only crypto and database code.
export const mappedEvents = {
  stripe: [
    "customer.created", "customer.updated", "customer.deleted",
    "customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted",
    "customer.subscription.paused", "customer.subscription.resumed", "customer.subscription.trial_will_end",
    "checkout.session.completed", "checkout.session.async_payment_succeeded", "checkout.session.async_payment_failed",
    "invoice.created", "invoice.finalized", "invoice.paid", "invoice.payment_succeeded",
    "invoice.payment_failed", "invoice.payment_action_required", "invoice.voided", "invoice.marked_uncollectible",
  ].map((event) => `stripe.${event}`),
  clerk: ["clerk.user.created", "clerk.user.updated", "clerk.user.deleted"],
  supabase: ["supabase.user.created", "supabase.user.updated"],
  webhook: [],
};

export type IntegrationDraft = {
  provider: IntegrationInput["provider"]; name: string; slug: string; secret: string;
  mapPlan: boolean; deleteContact: boolean; secretHeader: string;
  restrictedKey: string; removeKey: boolean;
};

export function integrationDraft(row?: Integration): IntegrationDraft {
  return {
    provider: row?.provider ?? "stripe", name: row?.name ?? "", slug: row?.slug ?? "webhook", secret: "",
    mapPlan: row?.settings.map_plan ?? false, deleteContact: row?.settings.delete_contact ?? false,
    secretHeader: row?.settings.secret_header ?? "x-webhook-secret", restrictedKey: "", removeKey: false,
  };
}

export function validDraft(value: IntegrationDraft, editing = false): boolean {
  return Boolean(value.name.trim() && value.name.trim().length <= 120
    && (editing || value.secret) && value.secret.length <= 4096
    && value.restrictedKey.length <= 1000
    && (value.provider !== "webhook" || (/^[a-z][a-z0-9-]{0,62}$/.test(value.slug)
      && !["stripe", "clerk", "supabase"].includes(value.slug)))
    && (value.provider !== "supabase" || /^[a-zA-Z0-9-]{1,78}$/.test(value.secretHeader)));
}

export function integrationPayload(value: IntegrationDraft, editing: true): IntegrationUpdate;
export function integrationPayload(value: IntegrationDraft, editing?: false): IntegrationInput;
export function integrationPayload(value: IntegrationDraft, editing = false): IntegrationInput | IntegrationUpdate {
  const settings: IntegrationInput["settings"] = value.provider === "stripe"
    ? { map_plan: value.mapPlan, ...(value.removeKey ? { stripe_restricted_key: null }
      : value.restrictedKey ? { stripe_restricted_key: value.restrictedKey } : {}) }
    : value.provider === "clerk" ? { delete_contact: value.deleteContact }
      : value.provider === "supabase" ? { secret_header: value.secretHeader } : {};
  const common = { name: value.name.trim(), settings, ...(value.secret ? { secret: value.secret } : {}) };
  return editing ? common : {
    ...common, provider: value.provider, secret: value.secret,
    ...(value.provider === "webhook" ? { slug: value.slug } : {}),
  };
}

export function MappedEvents({ provider, slug = "webhook" }: { provider: IntegrationInput["provider"]; slug?: string }) {
  return (
    <div className="stack">
      <h3>Mapped events</h3>
      {provider === "webhook" ? <p>Events are prefixed with <code>{slug}.&lt;event&gt;</code>. Internal @ events are not allowed.</p>
        : <ul>{mappedEvents[provider].map((event) => <li key={event}><code>{event}</code></li>)}</ul>}
      {provider === "stripe" ? <p className="muted">Invoice events include AMOUNT, UPDATE_PAYMENT_URL (the hosted invoice payment link), INVOICE_NUMBER, invoice_id, and PLAN. Plan storage is opt-in.</p> : null}
      {provider === "clerk" ? <p className="muted">User lifecycle events, not authentication email delivery. Deletion retains the contact and its history by default.</p> : null}
      {provider === "supabase" ? <p className="muted">Database webhooks for INSERT and UPDATE on auth.users, not the send-email hook.</p> : null}
    </div>
  );
}

export function IntegrationFields({ value, onChange, integration, disabled = false }: {
  value: IntegrationDraft; onChange: (value: IntegrationDraft) => void; integration?: Integration; disabled?: boolean;
}) {
  const change = <K extends keyof IntegrationDraft>(key: K, next: IntegrationDraft[K]) => onChange({ ...value, [key]: next });
  return (
    <div className="form">
      <Select label="Provider" value={value.provider} options={providers} disabled={disabled || Boolean(integration)}
        onChange={(provider) => onChange({ ...integrationDraft(), provider: provider as IntegrationInput["provider"], name: value.name })} />
      <Field label="Name" value={value.name} onChange={(name) => change("name", name)} disabled={disabled} required autoFocus />
      {value.provider === "webhook" ? <Field label="Event namespace" value={value.slug} onChange={(slug) => change("slug", slug)}
        disabled={disabled || Boolean(integration)} required hint="Default: webhook. Lowercase letters, digits and hyphens; stripe, clerk and supabase are reserved." /> : null}
      <Field label={value.provider === "supabase" ? "Shared secret" : "Signing secret"} type="password" value={value.secret}
        onChange={(secret) => change("secret", secret)} disabled={disabled} autoComplete="new-password" required={!integration}
        hint={integration ? "Leave blank to keep the existing secret. Stored secrets are never shown." : "Use the secret configured in your provider."} />
      {value.provider === "stripe" ? <>
        <Switch label="Store plan on contacts" checked={value.mapPlan} onChange={(checked) => change("mapPlan", checked)}
          disabled={disabled} hint="Opt in to storing the price lookup key in properties.plan." />
        <Field label="Restricted Stripe key" type="password" value={value.restrictedKey} onChange={(key) => change("restrictedKey", key)}
          disabled={disabled || value.removeKey} autoComplete="new-password"
          hint={`Optional customer lookup. ${integration?.has_restricted_key ? "A key is stored; leave blank to keep it." : "No stored key is shown."}`} />
        {integration?.has_restricted_key ? <Switch label="Remove restricted key" checked={value.removeKey}
          onChange={(checked) => onChange({ ...value, removeKey: checked, restrictedKey: "" })} disabled={disabled} /> : null}
      </> : null}
      {value.provider === "clerk" ? <Switch label="Delete contact when Clerk user is deleted" checked={value.deleteContact}
        onChange={(checked) => change("deleteContact", checked)} disabled={disabled}
        hint="Off by default: retain the contact and history. Turning this on uses ordinary contact deletion, not privacy erasure." /> : null}
      {value.provider === "supabase" ? <Field label="Secret header" value={value.secretHeader} onChange={(header) => change("secretHeader", header)}
        disabled={disabled} required hint="Configure this header and the shared secret in the database webhook." /> : null}
      <MappedEvents provider={value.provider} slug={value.slug} />
    </div>
  );
}
