# Standard Webhooks

## Receiver setup

Create a Standard Webhooks integration in **Settings > Integrations**, or use:

```sh
jq -n --arg secret "$WEBHOOK_SIGNING_SECRET" \
  '{provider:"webhook",name:"App lifecycle",secret:$secret}' |
curl --fail-with-body --silent --show-error "$DISPATCH_API_URL/integrations" \
  -H "Authorization: Bearer $DISPATCH_API_KEY" \
  -H "Content-Type: application/json" --data-binary @-
```

`secret` is the sender's Standard Webhooks signing secret (a base64 key, optionally prefixed `whsec_`). Create returns safe integration fields plus flat, top-level `token` and `url` once. Configure the sender to POST to that URL.

The default slug is **`webhook`**. To use another namespace, add `"slug":"product"` on create. Slugs must match **`[a-z][a-z0-9-]{0,62}`**, be unique among live integrations in the tenant, and must not be `stripe`, `clerk` or `supabase`. Provider and slug cannot be edited later.

Sign the original request bytes using Standard Webhooks v1 HMAC-SHA256: the signed content is `<id>.<timestamp>.<raw body>` and the signature value is `v1,<base64 signature>`. Send a complete `webhook-id`, `webhook-timestamp`, `webhook-signature` family, or a complete `svix-id`, `svix-timestamp`, `svix-signature` family. Do not mix them. The timestamp is Unix seconds and must be within 300 seconds of the receiver's clock. Use your sender's supported signing library; the URL token alone is not authentication.

Normal GETs never expose the URL or credentials. `POST /integrations/:id/rotate` returns a replacement URL once; update your sender before further delivery. [Body-free history and replay retention](../integrations.md#delivery-history-and-replay-retention) use `LOG_RETENTION_DAYS`, default 30 days. After pruning, a correctly signed redelivery with the same delivery ID can apply again.

## Payload and mapping

```json
{
  "event": "user.activated",
  "email": "person@example.com",
  "contact": {
    "first_name": "Sam",
    "properties": {"activation_source": "import"}
  },
  "data": {"activated_at": "2026-10-01T12:00:00Z"}
}
```

Use an actual recipient for live sends; `example.com` above is only a sample. `event`, a valid `email` and an object `data` are required. `contact` is optional and accepts only `first_name`, `last_name` and `properties`. Declare custom contact properties with compatible types before using them.

The default mapping above records **`webhook.user.activated`**; a `product` slug records `product.user.activated`. Do not include the slug in `event` unless you intend it to appear twice. The combined event name has a 120-character limit, and the source event must not start with `@`. Reserved internal contact-trigger keys are not an input API.

Mapped contact fields merge into the contact without replacing its preferences. Deleted contacts are not revived. Matching contact and event automations may start, but a receiver does not install or enable them. App events sent directly through `POST /events/send` keep their own names and do not acquire this slug.

## Manual app-event alternative

If your application already owns event production, send the event directly using a Dispatch API key instead of signing an inbound webhook:

```sh
jq -n --arg email "$CONTACT_EMAIL" \
  '{event:"user.activated",email:$email,payload:{activated_at:"2026-10-01T12:00:00Z"}}' |
curl --fail-with-body --silent --show-error "$DISPATCH_API_URL/events/send" \
  -H "Authorization: Bearer $DISPATCH_API_KEY" \
  -H "Content-Type: application/json" --data-binary @-
```

Replace the timestamp with the actual app value. This alternative records `user.activated`, not `webhook.user.activated`. Your application owns retries, ordering and business deduplication. Do not send both forms for the same business action unless the two automation triggers and duplicate effects are intentional. Direct template mail remains available through `POST /emails`; no integration is required.
