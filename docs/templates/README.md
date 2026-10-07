# Template recipes

`pnpm db:seed` installs the sixteen default templates and publishes them. A send names the alias and passes only the required variables. Brand values such as `PRODUCT_NAME` come from `GET /brand` and do not have to be in the send.

For lifecycle events, start with a receiver in [Settings > Integrations](../integrations.md). Create it with `POST /integrations`, copy the one-time receiver URL and configure the provider's signing secret. Normal GET responses never return credentials. Receiver setup does not install templates or enable automations.

- [Stripe](stripe.md) billing receiver first, manual invoice and trial email handlers second
- [Clerk](clerk.md) user lifecycle receiver first, provider-rendered authentication email delivery second
- [Supabase](supabase.md) Database Webhooks receiver first, separate Auth Send Email Hook second
- [Standard Webhooks](webhook.md) signed lifecycle receiver and manual app-event alternative
- [Auth.js](authjs.md) email provider
- [Better Auth](better-auth.md) send callbacks

The manual recipes map payloads onto template aliases and call `POST /emails`, or send app events for an automation. Auth.js and Better Auth remain code-owned sending integrations. Clerk renders its own authentication messages; it has no Dispatch authentication template. A Supabase lifecycle webhook is not an Auth Send Email Hook.

All examples use `DISPATCH_API_URL` for the API base URL, without a trailing slash, and `DISPATCH_API_KEY` for authentication. Receiver management needs full access; direct email sends can use a sending key. Manual handlers also use `DISPATCH_FROM` for a verified sender where indicated.

Review template variables, publication, sender and business timing before enabling an automation. In particular, a Stripe receiver supplies a hosted invoice link, not a billing-portal card-update session. See [Failed payment](../automations/failed-payment.md).
