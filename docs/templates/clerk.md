# Clerk

## Receiver setup

For user lifecycle events, create a Clerk integration in **Settings > Integrations**, or use:

```sh
jq -n --arg secret "$CLERK_WEBHOOK_SECRET" \
  '{provider:"clerk",name:"Clerk users",secret:$secret,settings:{delete_contact:false}}' |
curl --fail-with-body --silent --show-error "$DISPATCH_API_URL/integrations" \
  -H "Authorization: Bearer $DISPATCH_API_KEY" \
  -H "Content-Type: application/json" --data-binary @-
```

The response includes flat, top-level `token` and `url` once. Configure a Clerk webhook endpoint with that URL, subscribe to `user.created`, `user.updated` and `user.deleted`, and save the endpoint's signing secret in Dispatch. If the endpoint must exist to obtain its secret, replace a private temporary secret with `PATCH /integrations/:id` before accepting deliveries. Dispatch verifies Clerk's `svix-id`, `svix-timestamp` and `svix-signature` against the original bytes with a 300-second tolerance.

Normal GETs do not return the URL or credentials. `POST /integrations/:id/rotate` returns a replacement URL once; update the endpoint in Clerk. [Delivery history](../integrations.md#delivery-history-and-replay-retention) is body-free, with `processed`, `ignored` and `failed` results. Its replay keys expire with `LOG_RETENTION_DAYS` (default 30 days).

| Provider event | Dispatch event | Contact mapping |
| --- | --- | --- |
| `user.created` | `clerk.user.created` | Primary email, first and last names, `properties.clerk_user_id` |
| `user.updated` | `clerk.user.updated` | Same fields; existing preferences are preserved |
| `user.deleted` | `clerk.user.deleted` | Resolve the existing contact by `clerk_user_id`; retain it and its history by default |

The receiver never picks an arbitrary secondary email for a phone-only or missing-primary-email user, and never revives a deleted contact. Creation/update event data includes `user_id`, `email`, mapped names and properties; deletion data includes `user_id`. Explicit `settings.delete_contact: true` opts into ordinary contact deletion, not privacy erasure. Deletion does not create a missing contact.

This receiver does **not** forward Clerk-rendered authentication emails. Lifecycle events and authentication message delivery are separate configurations.

## Manual authentication email alternative

There is no Clerk template in the library. Clerk renders the email. Dispatch only delivers the HTML Clerk already produced.

Turn **Delivered by Clerk** off on each template you want to send yourself. The switch is per template. Clerk's email template settings, updated 2026-09-30, say to listen for `emails.created`. The deliverability page from the same day says `email.created`. Subscribe to the name your dashboard's event catalog shows. Both pages describe the same handoff.

The event carries the rendered message. For a verification code, the payload includes `otp_code`. The Email resource Clerk's API documents has `to_email_address`, `subject`, `body`, `body_plain`, `from_email_name`, `slug`, and `delivered_by_clerk`. Forward `body` as `html` and `body_plain` as `text`. Do not run it through `password-reset` or `one-time-code`. The wording is already Clerk's.

Verify the webhook before you send. Clerk's current backend helper is `verifyWebhook` from `@clerk/backend/webhooks`.

```ts
import { verifyWebhook } from "@clerk/backend/webhooks";

export async function handleClerk(request: Request) {
  const event = await verifyWebhook(request);
  if (event.type !== "email.created" && event.type !== "emails.created") return;
  const email = event.data as {
    to_email_address?: string;
    subject?: string;
    body?: string;
    body_plain?: string;
    delivered_by_clerk?: boolean;
  };
  if (!email.to_email_address || !email.subject || !email.body) return;
  if (email.delivered_by_clerk) return;
  const response = await fetch(`${process.env.DISPATCH_API_URL}/emails`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.DISPATCH_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from: process.env.DISPATCH_FROM,
      to: email.to_email_address,
      subject: email.subject,
      html: email.body,
      text: email.body_plain,
    }),
  });
  if (!response.ok) throw new Error(await response.text());
}
```

`from_email_name` is the local part Clerk would have used. The From address on the Dispatch send still has to be a domain you have verified. Set `DISPATCH_FROM` to that address.
