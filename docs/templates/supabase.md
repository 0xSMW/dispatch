# Supabase

## Receiver setup

For user lifecycle events, use **Database Webhooks**, not the Auth Send Email Hook. Create a Supabase integration in **Settings > Integrations**, or use:

```sh
jq -n --arg secret "$SUPABASE_WEBHOOK_SECRET" \
  '{provider:"supabase",name:"Supabase users",secret:$secret,settings:{secret_header:"x-dispatch-secret"}}' |
curl --fail-with-body --silent --show-error "$DISPATCH_API_URL/integrations" \
  -H "Authorization: Bearer $DISPATCH_API_KEY" \
  -H "Content-Type: application/json" --data-binary @-
```

Create returns flat, top-level `token` and `url` once. Configure Database Webhooks for `auth.users` **INSERT** and **UPDATE**, POST to that URL with a JSON body, and add `x-dispatch-secret` with the exact shared secret used above. If you choose another header, set its name in `settings.secret_header`. This is shared-header authentication, not an Auth Hook `v1,whsec_...` signature.

Normal GETs never return the URL or secrets. Rotate with `POST /integrations/:id/rotate` and replace the URL in Supabase. [Body-free delivery history](../integrations.md#delivery-history-and-replay-retention) shows `processed`, `ignored` or `failed`. Supabase Database Webhooks have no signing timestamp or delivery ID: replay identity is a hash of the raw body plus `commit_timestamp` when present. **Replay protection lasts only while the delivery key is retained**, with `LOG_RETENTION_DAYS` defaulting to 30 days. Use HTTPS, protect the shared header and keep longer-lived business deduplication if needed.

| Database payload | Dispatch event | Contact mapping |
| --- | --- | --- |
| `schema:"auth"`, `table:"users"`, `type:"INSERT"` | `supabase.user.created` | `record.email`, `record.id` as `properties.supabase_user_id`, and metadata first/last names |
| Same table with `type:"UPDATE"` | `supabase.user.updated` | Same fields; existing preferences are preserved |

The receiver supports these two operations, not DELETE or arbitrary tables. Event data includes `user_id`, `email`, mapped names and properties, not passwords, tokens or the whole auth record. Missing email is ignored with `no_contact`. Deleted Dispatch contacts are not revived. Receiving these events does not send verification, recovery or magic-link mail automatically.

## Manual Auth Send Email Hook alternative

Checked against the Send Email Hook guide on 2026-10-01. The body is `{ user, email_data }`. The inputs table on that page says `email`. The JSON schema and the hook samples use `email_data`. Use `email_data`.

Configure this as a separate **Auth Send Email Hook** pointing to your own verified handler below, not `/inbound/{token}`. It sends authentication messages through `POST /emails`; it is not the Database Webhooks lifecycle receiver.

`user.email` is the account email. `email_data.email_action_type` picks the template.

| `email_action_type` | Template | Required variables |
| --- | --- | --- |
| `signup`, `email` | `verify-email` | `ACTION_URL`. Pass `CODE` as `token` when you want the six-digit code in the mail. |
| `recovery` | `password-reset` | `ACTION_URL` |
| `magiclink` | `magic-link` | `ACTION_URL`. `CODE` is optional. |
| `invite` | `invitation` | `ACTION_URL` |
| `email_change` | `verify-email` | `ACTION_URL`, sent once or twice. See below. |
| `reauthentication` | `one-time-code` | `CODE` from `token` |
| the seven `*_notification` values | `security-notice` | `CHANGE`, `SECURE_ACCOUNT_URL` |

The seven notification types are `password_changed_notification`, `email_changed_notification`, `phone_changed_notification`, `identity_linked_notification`, `identity_unlinked_notification`, `mfa_factor_enrolled_notification`, and `mfa_factor_unenrolled_notification`. Supabase does not send a URL for those. `SECURE_ACCOUNT_URL` is your account page. `CHANGE` is a short sentence you write, because the template subject is `{{{CHANGE}}}`.

Build the confirm link on the project host, the way Supabase's own sample does. `site_url` is the app, not the verify endpoint.

```txt
https://<project-ref>.supabase.co/auth/v1/verify?token=<token_hash>&type=<email_action_type>&redirect_to=<redirect_to>
```

The hook secret looks like `v1,whsec_...`. Strip `v1,whsec_` before you pass it to `standardwebhooks`. An empty 200 means the hook succeeded.

`email_change` is the one that is easy to get backwards. When Secure Email Change is on, Supabase sends two pairs, and the `_new` suffix does not mean the new address.

- Mail to the current address, `user.email`, uses `token` and `token_hash_new`.
- Mail to the new address, `user.new_email`, uses `token_new` and `token_hash`.

When Secure Email Change is off, one pair is present. Send one message to `user.new_email`, using whichever of `token` or `token_new` came with `token_hash`.

```ts
import { Webhook } from "standardwebhooks";

const secret = process.env.SEND_EMAIL_HOOK_SECRET!.replace("v1,whsec_", "");
const hook = new Webhook(secret);

const change = {
  password_changed_notification: "Your password was changed",
  email_changed_notification: "Your email address was changed",
  phone_changed_notification: "Your phone number was changed",
  identity_linked_notification: "A sign-in method was added",
  identity_unlinked_notification: "A sign-in method was removed",
  mfa_factor_enrolled_notification: "Two-factor authentication was turned on",
  mfa_factor_unenrolled_notification: "Two-factor authentication was turned off",
} as const;

function verifyUrl(projectRef: string, emailData: { token_hash: string; email_action_type: string; redirect_to: string }) {
  const params = new URLSearchParams({
    token: emailData.token_hash,
    type: emailData.email_action_type,
    redirect_to: emailData.redirect_to,
  });
  return `https://${projectRef}.supabase.co/auth/v1/verify?${params}`;
}

async function send(to: string, id: string, variables: Record<string, string>) {
  const response = await fetch(`${process.env.DISPATCH_BASE_URL}/emails`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.DISPATCH_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ from: process.env.DISPATCH_FROM, to, template: { id, variables } }),
  });
  if (!response.ok) throw new Error(await response.text());
}

export async function handleSupabase(payload: string, headers: Record<string, string>, projectRef: string) {
  const { user, email_data } = hook.verify(payload, headers) as {
    user: { email: string; new_email?: string };
    email_data: {
      token: string;
      token_hash: string;
      token_new: string;
      token_hash_new: string;
      redirect_to: string;
      email_action_type: string;
    };
  };
  const type = email_data.email_action_type;
  if (type in change) {
    await send(user.email, "security-notice", {
      CHANGE: change[type as keyof typeof change],
      SECURE_ACCOUNT_URL: process.env.ACCOUNT_URL!,
    });
    return;
  }
  if (type === "reauthentication") {
    await send(user.email, "one-time-code", { CODE: email_data.token });
    return;
  }
  if (type === "email_change" && email_data.token_hash_new && user.new_email) {
    await send(user.email, "verify-email", {
      ACTION_URL: verifyUrl(projectRef, { ...email_data, token_hash: email_data.token_hash_new }),
      CODE: email_data.token,
    });
    await send(user.new_email, "verify-email", {
      ACTION_URL: verifyUrl(projectRef, email_data),
      CODE: email_data.token_new,
    });
    return;
  }
  const link = verifyUrl(projectRef, email_data);
  const template =
    type === "recovery" ? "password-reset" :
    type === "magiclink" ? "magic-link" :
    type === "invite" ? "invitation" :
    "verify-email";
  await send(type === "email_change" ? user.new_email ?? user.email : user.email, template, {
    ACTION_URL: link,
    // With Secure Email Change off, the one code arrives in whichever field Supabase filled.
    CODE: email_data.token || email_data.token_new,
  });
}
```

`invitation` does not receive the inviter's name. Leave `INVITER_NAME` unset and the template uses "A teammate".
