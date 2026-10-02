# Template recipes

`pnpm db:seed` installs the sixteen default templates and publishes them. A send names the alias and passes only the required variables. Brand values such as `PRODUCT_NAME` come from `GET /brand` and do not have to be in the send.

Each recipe below maps one partner payload onto those aliases and calls `POST /emails`. Field names were checked against the partner docs on 2026-10-01.

- [Supabase Auth](supabase.md) send-email hook
- [Auth.js](authjs.md) email provider
- [Better Auth](better-auth.md) send callbacks
- [Stripe](stripe.md) invoice and trial webhooks
- [Clerk](clerk.md) has no Dispatch template. Clerk renders the message.
