# Deliverability

These controls are in the product today:

- A send needs a verified sender domain. An unverified domain fails with `validation_error` (403), and so does one with sending disabled.
- Each email has at most 50 recipients across `to`, `cc`, and `bcc`.
- Attachments are capped at 40 MB in total after base64 encoding.
- Every send is checked against the tenant's suppression list. A suppressed address is not sent to and gets `email.suppressed`.
- A permanent bounce or a complaint suppresses the address. Transient bounces do not.
- A send with `topic_id` skips contacts who opted out of that topic.
- Broadcasts skip unsubscribed contacts, suppressed addresses, and contacts opted out of the broadcast's topic. `GET /broadcasts/{id}/audience` shows those counts before you send.
- Broadcast emails carry `List-Unsubscribe` and `List-Unsubscribe-Post` headers, and the one-click POST to `/unsubscribe/{token}` works without a key.
- Each domain gets DKIM, SPF on a custom MAIL FROM subdomain, and a DMARC record with `p=none`.
- `GET /emails/{id}/insights` checks a sent email for links to other domains, a missing DMARC record, a missing text part, a no-reply sender, HTML over Gmail's 102 KB clipping limit, shortened YouTube links, sending from the root domain, and tracking on the shared host.
- `GET /emails/metrics` reports delivery, open, click, bounce, and complaint rates.

Dispatch does not manage dedicated IPs or SES account-level suppression. `GET /system` reports the account's sending quota and whether it is still in the SES sandbox, and the rest happens in the SES console.
