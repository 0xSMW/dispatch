# Better Auth

Checked against the Better Auth email hooks and the email OTP plugin on 2026-10-01. These are the self-hosted callbacks. The hosted `@better-auth/infra` templates use different variable names. Do not copy those into a Dispatch send.

Do not `await` the Dispatch call inside the hook. Better Auth treats a slow hook as a timing signal. Do catch its errors. `send` throws on any response that is not 2xx, and a rejected promise that nothing handles stops a Node process.

`sendResetPassword` and `sendVerificationEmail` both receive `{ user, url, token }` and the request. `user.email` is the recipient. `url` is the link. `token` is the token inside that link, not a code to print, unless you are in the OTP plugin.

| Callback | Template | Variables |
| --- | --- | --- |
| `sendResetPassword` | `password-reset` | `ACTION_URL` = `url` |
| `sendVerificationEmail` | `verify-email` | `ACTION_URL` = `url` |
| `sendVerificationOTP` | `one-time-code` | `CODE` = `otp` |

`sendVerificationOTP` receives `{ email, otp, type }`. `type` is `sign-in`, `email-verification`, or `forget-password`. All three use `one-time-code`. The address is `email`, not `user.email`.

Set `DISPATCH_API_URL` to your Dispatch API base URL (without a trailing slash), `DISPATCH_API_KEY` to a sending key, and `DISPATCH_FROM` to an address on a verified domain.

```ts
async function send(to: string, id: string, variables: Record<string, string>) {
  const response = await fetch(`${process.env.DISPATCH_API_URL}/emails`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.DISPATCH_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ from: process.env.DISPATCH_FROM, to, template: { id, variables } }),
  });
  if (!response.ok) throw new Error(await response.text());
}

function failed(error: unknown) {
  console.error("Dispatch send failed", error);
}

export const auth = {
  emailAndPassword: {
    sendResetPassword({ user, url }: { user: { email: string }; url: string }) {
      send(user.email, "password-reset", { ACTION_URL: url }).catch(failed);
    },
  },
  emailVerification: {
    sendVerificationEmail({ user, url }: { user: { email: string }; url: string }) {
      send(user.email, "verify-email", { ACTION_URL: url }).catch(failed);
    },
  },
  emailOTP: {
    sendVerificationOTP({ email, otp }: { email: string; otp: string; type: string }) {
      send(email, "one-time-code", { CODE: otp }).catch(failed);
    },
  },
};
```
