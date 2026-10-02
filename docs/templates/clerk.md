# Clerk

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
  const response = await fetch(`${process.env.DISPATCH_BASE_URL}/emails`, {
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
