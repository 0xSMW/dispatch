# SMTP relay

`apps/smtp` accepts mail over SMTP and sends it through the same path as `POST /emails`. Point an app, a CMS, or anything else that only speaks SMTP at it. A migrated Resend config needs a new host and password and nothing else.

Run it locally with `pnpm dev:smtp`.

## Ports

| Port | Mode | When |
|:---|:---|:---|
| `SMTP_PORT`, default 587 and 2587 | Plain, upgraded with STARTTLS | Always |
| `SMTP_TLS_PORT`, default 465 and 2465 | Implicit TLS | Only when `SMTP_TLS_CERT` and `SMTP_TLS_KEY` are set |

Each setting takes one port or several, separated by commas. The defaults are the pairs Resend offers. The high ports are for networks that block the low ones. A port that cannot be bound is logged and the others keep listening.

Without a certificate, STARTTLS falls back to the self-signed certificate that ships with `smtp-server`, and the TLS ports stay closed. In production, set both paths to a certificate for the relay's hostname, or terminate TLS at a network load balancer with an ACM certificate.

Outside production the relay also accepts AUTH over an unencrypted connection, so a local client can connect without a certificate. With `NODE_ENV=production`, AUTH requires TLS.

## Credentials

| Field | Value |
|:---|:---|
| Username | `dispatch`. `resend` also works. |
| Password | An API key, `sk_...` |
| AUTH methods | `PLAIN`, `LOGIN` |

A `send` key is enough. The relay checks the key the same way the API does, a peppered HMAC of the secret compared against `api_keys.hash`, so it needs the same `API_KEY_PEPPER`. A revoked or unknown key gets `535`. A key restricted to one domain can only send from that domain.

## Environment

| Variable | Default | Purpose |
|:---|:---|:---|
| `SMTP_PORT` | `587,2587` | STARTTLS listeners |
| `SMTP_TLS_PORT` | `465,2465` | Implicit TLS listeners |
| `SMTP_TLS_CERT` | unset | Path to a PEM certificate chain |
| `SMTP_TLS_KEY` | unset | Path to the PEM private key |
| `SMTP_HOSTNAME` | the machine hostname | Name in the greeting |
| `SMTP_HOST` | unset | The relay's public hostname. The API reports it in `GET /system` and the dashboard shows it on the SMTP settings page. |
| `SMTP_MAX_CLIENTS` | `50` | Open connections at once. Each message is held in memory while it is parsed. |

The relay also reads `DATABASE_URL`, `REDIS_URL`, `API_KEY_PEPPER`, `PUBLIC_URL`, `RATE_LIMIT_PER_SECOND`, `AWS_REGION`, and the `STORAGE_*` and `S3_*` variables, with the same meaning they have for the API. In production it refuses to start without `API_KEY_PEPPER` and `PUBLIC_URL`.

On Linux, binding a port below 1024 needs root or `CAP_NET_BIND_SERVICE`. Set `SMTP_PORT=2587` for local work if that gets in the way.

## How a message maps to a send

The relay parses the message with `postal-mime` and builds the same body `POST /emails` takes.

- `from` comes from the `From` header, display name included, so `"Acme" <hello@acme.com>` becomes `Acme <hello@acme.com>`. With no `From` header, it uses `MAIL FROM`.
- The envelope decides who receives the message. `to` and `cc` are the header recipients that `RCPT TO` also names. A header recipient that the envelope does not name is dropped, so a client that sends one message in several envelopes does not cause duplicate sends.
- An envelope recipient that neither `To` nor `Cc` names is a hidden recipient. Beside visible recipients it becomes `bcc`.
- If the envelope leaves no `To` recipient, the `Cc` recipients take its place.
- If nobody is visible at all, each hidden recipient gets an email of their own. This is what a Bcc-only message (`To: undisclosed-recipients:;`) or a mailing-list expansion looks like. One shared `to` list would show every recipient the others' addresses. The reply names the first email, and the count of emails is the count of recipients.
- `reply_to` comes from its header.
- `subject`, `html`, and `text` come from the message. With HTML and no text part, Dispatch generates the text as it does for the API.
- Attachments keep their filename and type. A part with a `Content-ID` becomes an inline attachment with `content_id`, so `<img src="cid:logo">` keeps working. A part with no filename gets one from its type, such as `attachment.ics` for a calendar invite. An empty attachment is dropped.
- A message that is only an attachment, as a scanner sends, goes out with a blank text body.
- Any other header, such as `X-Entity-Ref-ID`, `List-Unsubscribe`, or `In-Reply-To`, passes through as a custom header. Structural headers like `Message-ID`, `Date`, `Received`, and `Content-*` do not. `X-SES-*` headers are dropped, because SES reads them as instructions.

## Retries and duplicates

An SMTP client that does not see the `250` sends the message again. The relay recognizes the second copy and answers with the first email's ID.

- With `Dispatch-Idempotency-Key` or `Resend-Idempotency-Key` (1 to 256 characters), that key identifies the delivery. If both are present, the Dispatch one wins. Neither is copied onto the outgoing message.
- Without one, the `Message-ID` header does. A message with neither can be sent twice by a retry.

Both are combined with the envelope's recipients, so one message delivered in two envelopes is two deliveries. Keys are kept for 24 hours.

A successful send answers `250 Queued as email_...`. Look the email up with `GET /emails/:id`.

## Limits and replies

| Case | Reply |
|:---|:---|
| Bad username, unknown or revoked key | `535` |
| Validation failure, such as an unverified sender domain or a missing subject | `550` |
| A message the parser cannot read | `550` |
| More than 50 recipients in `RCPT TO` | `452` on the 51st `RCPT TO` |
| Message over 40 MB | `552` |
| Rate limit: SMTP and API requests count into one bucket per tenant, `RATE_LIMIT_PER_SECOND` (default 10) | `451`, retry later |
| Server error | `451`, retry later |

The 40 MB cap is on the raw message, and the relay advertises it with the `SIZE` extension.

## Not supported

- Scheduling. There is no header for `scheduled_at`, the same as Resend's relay.
- Tags, templates, and `topic_id`.
- Port 25. Add it to `SMTP_PORT` if you need it.
- `CRAM-MD5` and `XOAUTH2` auth.
- Relaying unchanged MIME. Dispatch rebuilds the message from the parsed fields, so a custom MIME structure or an existing DKIM signature does not survive.
