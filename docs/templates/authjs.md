# Auth.js email provider

Checked against the Auth.js email provider reference and the Resend provider guide on 2026-10-01. The Email provider has one send callback, `sendVerificationRequest`. There is no separate password-reset, verify-email, or one-time-code callback. Those other templates are for Better Auth and for Supabase.

The callback receives `identifier`, `url`, `provider`, `theme`, `token`, `expires`, and `request`. `identifier` is the address to send to. `url` is the link that consumes the verification token. `token` is that same secret. It is not a short code the reader types, so do not put it in `CODE`.

Use `magic-link` and pass `url` as `ACTION_URL`. `provider.from` is the From address Auth.js was configured with.

```ts
import type { EmailConfig } from "@auth/core/providers";

export async function sendVerificationRequest(params: {
  identifier: string;
  url: string;
  provider: EmailConfig;
}) {
  const response = await fetch(`${process.env.DISPATCH_BASE_URL}/emails`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.DISPATCH_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from: params.provider.from,
      to: params.identifier,
      template: { id: "magic-link", variables: { ACTION_URL: params.url } },
    }),
  });
  if (!response.ok) throw new Error(await response.text());
}
```

The Email provider still needs a database adapter. Auth.js stores the verification token and looks it up when the link is opened. Dispatch only delivers the message.
