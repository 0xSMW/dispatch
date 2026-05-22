# Webhooks

Dispatch signs webhook payloads with timestamped HMAC headers:

- `Dispatch-Webhook-Id`
- `Dispatch-Webhook-Timestamp`
- `Dispatch-Webhook-Signature`

The signed content is:

```txt
<id>.<timestamp>.<raw-json-body>
```

Webhook delivery is never inline with provider callbacks or API requests. Events are appended first, then queued for delivery.

Failed deliveries create a failed attempt row and enqueue the next attempt with exponential backoff. Replays create a fresh queued attempt without mutating the original event.

Local v1 emits `email.received`, `email.opened`, and `email.clicked` in addition to send lifecycle events. Received-email webhook payloads stay metadata-only; retrieve bodies and attachments through the received-email API.
