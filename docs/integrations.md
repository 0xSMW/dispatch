# Integrations

Connect Stripe, Clerk, Supabase Database Webhooks or a Standard Webhooks sender to Dispatch. A receiver maps verified deliveries to contacts and namespaced events. It does not install templates or enable automations. Sending through `POST /emails` still needs no integration.

## Create a receiver

In **Settings > Integrations** (`/settings/integrations`), use a provider's **Connect** tile, give the integration a name and enter its signing secret. Supabase uses a shared header secret instead. Each tile links to its receiver setup guide. Copy the receiver URL when it is shown, then configure the provider to POST to that exact URL. Dismissing the one-time display or leaving the page clears it; rotate if you lose the URL.

The same page links to outgoing Webhooks, SMTP, Auth.js and Better Auth setup. Viewers can follow these links and inspect existing integrations, but only full-access users see Connect or other mutation controls.

The same setup uses an authenticated API request. This Stripe example assumes `DISPATCH_API_URL`, a full-access `DISPATCH_API_KEY` and the endpoint's `STRIPE_WEBHOOK_SECRET` are already set:

```sh
jq -n --arg secret "$STRIPE_WEBHOOK_SECRET" \
  '{provider:"stripe",name:"Stripe billing",secret:$secret,settings:{map_plan:false}}' |
curl --fail-with-body --silent --show-error \
  "$DISPATCH_API_URL/integrations" \
  -H "Authorization: Bearer $DISPATCH_API_KEY" \
  -H "Content-Type: application/json" \
  --data-binary @-
```

Create returns the integration fields and **flat, top-level `token` and `url` fields**, not an `integration` wrapper. The following is an abbreviated shape, not a usable credential:

```json
{
  "object": "integration",
  "id": "integration_123",
  "provider": "stripe",
  "name": "Stripe billing",
  "slug": "stripe",
  "settings": {"map_plan": false, "delete_contact": false},
  "has_restricted_key": false,
  "token": "<shown once>",
  "url": "https://api.your-dispatch-host/inbound/<shown once>"
}
```

Treat the response and the entire URL as credentials. Store them privately, not in source control, screenshots or logs. The URL token is distinct from the provider signing secret; knowing the URL does not replace provider authentication. Dispatch stores a hash of the URL token and encrypted signing credentials.

Normal `GET /integrations` and `GET /integrations/:id` responses never contain a token, receiver URL, signing secret or restricted key. `has_restricted_key` only indicates whether a key is configured. Viewers can inspect safe integration details and history, but cannot create, edit, delete or rotate integrations.

## Provider setup

| Provider | Authentication and configuration | Mapped events |
| --- | --- | --- |
| [Stripe](templates/stripe.md#receiver-setup) | Configure the exact receiver URL as a Stripe webhook endpoint; save that endpoint's signing secret in Dispatch. Stripe supplies `Stripe-Signature`. | Supported customer, subscription, checkout and invoice events under `stripe.*`. |
| [Clerk](templates/clerk.md#receiver-setup) | Configure a Clerk webhook endpoint with its signing secret. Deliveries use `svix-id`, `svix-timestamp` and `svix-signature`. | `clerk.user.created`, `clerk.user.updated`, `clerk.user.deleted`. |
| [Supabase](templates/supabase.md#receiver-setup) | Configure Database Webhooks for `auth.users` INSERT and UPDATE, with a shared secret in the header named by `settings.secret_header`. | `supabase.user.created`, `supabase.user.updated`. Not an Auth Send Email Hook. |
| [Standard Webhooks](templates/webhook.md#receiver-setup) | Configure a sender with a Standard Webhooks signing secret and a complete `webhook-*` or `svix-*` header family. | `<slug>.<event>` from `{event,email,contact?,data}`. |

Stripe, Clerk and Standard Webhooks signatures are checked against the untouched request bytes with a 300-second timestamp tolerance. Do not put a proxy in front of the receiver that reformats its JSON. Supabase Database Webhooks use the configured shared header, not a timestamped signature. Use HTTPS and keep that header secret.

The public receiver is `POST /inbound/{token}`. It has a 1 MB body cap and public rate limiting; management routes still require API authentication. A receiver URL is not an outgoing Dispatch webhook endpoint.

## Events and contact changes

Provider events are separate from app-defined events and internal contact triggers:

- Provider events use `stripe.*`, `clerk.*`, `supabase.*` or the Standard Webhooks slug. For example, Stripe's `invoice.paid` becomes `stripe.invoice.paid`.
- App-defined events such as `user.inactive` continue to come from your application through `POST /events/send`.
- Internal `@` trigger keys are reserved. Do not send them as provider or app events.

A receiver can create or update a contact and start matching contact-triggered or event-triggered automations. It preserves existing preferences and does not revive deleted contacts. A delivery without a resolvable contact is ignored with `no_contact`; it is not proof of an email send. Clerk deletion retains the contact and history by default; explicit contact deletion is not a privacy-erasure workflow.

## Manage and rotate

| Request | Purpose |
| --- | --- |
| `GET /integrations` | List safe integration details. |
| `GET /integrations/:id` | Read safe details. |
| `PATCH /integrations/:id` | Update name, secret or settings. Provider and slug cannot be changed. |
| `DELETE /integrations/:id` | Disable the receiver by deleting its integration. |
| `POST /integrations/:id/rotate` | Replace the URL token and return the replacement `token` and `url` once. |
| `GET /integrations/:id/deliveries` | Inspect body-free delivery history. |

To replace a lost or exposed URL:

```sh
curl --fail-with-body --silent --show-error \
  -X POST "$DISPATCH_API_URL/integrations/$INTEGRATION_ID/rotate" \
  -H "Authorization: Bearer $DISPATCH_API_KEY"
```

Rotate returns the same flat one-time credential shape as create. The old URL stops working. Replace the URL in the provider configuration immediately; rotation does not change the provider signing secret. To replace that secret, update the provider and `PATCH /integrations/:id` with the new `secret`. Do not expect a normal GET to recover either credential.

## Delivery history and replay retention

```sh
curl --fail-with-body --silent --show-error \
  "$DISPATCH_API_URL/integrations/$INTEGRATION_ID/deliveries?limit=20" \
  -H "Authorization: Bearer $DISPATCH_API_KEY"
```

The response is `{object:"list",has_more:false,data:[...]}`. The default is the most recent 20 deliveries; the maximum is 100. Rows contain delivery and provider-event IDs, `status`, `event_name`, `contact_id`, a sanitized `error` and `created_at`. They contain no request body, URL token or signing material.

In the dashboard, **View** shows mapped events and the last 20 deliveries. **Refresh deliveries** fetches current history. A matched contact links to its audience detail; unmatched or failed requests need not have a contact.

- `processed`: the mapped contact/event effects committed.
- `ignored`: no applicable mapping or contact effect, with a sanitized reason where available.
- `failed`: verification, payload or processing failed. Processing failures roll back contact, event, trigger and wait effects before a separate failure attempt is recorded.

Verified duplicate successful deliveries return HTTP 200 without repeating effects. Replay identity is scoped to the integration: Stripe uses its event ID, Clerk and Standard Webhooks use the signed delivery ID, and Supabase uses a hash of the raw body plus `commit_timestamp` when present. Failed attempts do not consume a successful replay key, so a corrected retry can still process. Providers can deliver out of order; deduplication does not establish billing or application ordering.

Delivery history and replay keys are pruned in bounded batches with log retention. `LOG_RETENTION_DAYS` defaults to **30 days**. After a delivery key is pruned, the receiver no longer remembers that event as a duplicate. A correctly authenticated redelivery can apply again. Supabase has no signing timestamp, so its replay protection in particular is bounded by this retention. Keep longer-lived business deduplication in your app if your policy requires it.

## Keep code-owned alternatives

Receivers are optional. The provider guides retain manual verified handlers for custom mapping and direct email sends. Do not feed the same delivery through both a receiver and a manual producer unless you deliberately prevent duplicate events and mail. See [Failed payment](automations/failed-payment.md) before enabling a billing automation, especially its invoice-correlation and cancellation limits.
