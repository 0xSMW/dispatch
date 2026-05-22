# Migration

Dispatch mirrors the simple Resend-style local workflow:

- bearer API keys
- `POST /v1/emails`
- `POST /v1/emails/batch`
- idempotency keys
- domains and DNS records
- templates
- contacts and suppressions
- webhooks with signed attempts and replay

For a transactional send migration, change the client base URL to `http://localhost:3100`, use a Dispatch API key, and keep the same core email payload shape:

```json
{
  "from": "hello@example.com",
  "to": "you@example.com",
  "subject": "Hello",
  "text": "Sent locally."
}
```

Batch compatibility intentionally rejects attachments and scheduled sends.

