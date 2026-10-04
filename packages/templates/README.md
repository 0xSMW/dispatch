# Templates

`@dispatchmail/templates` contains 25 emails and six lifecycle automation presets. The email components are in `emails/`, and preset definitions are in `src/presets.ts`. Building the package writes both `templates` and `automations` into `library.json`. Nothing in this package sends mail.

## Preview

From the repo root:

```
pnpm --filter @dispatchmail/templates exec email dev --dir emails
```

Folders whose names start with `_` stay out of the preview sidebar.

## Build checks

The build checks each template's content, variables, Transactional or Marketing kind, lifecycle stage, and when-to-use guidance before writing the library. Marketing templates need an unsubscribe link and company address in both HTML and plain text. Lifecycle emails use recipient-name fallbacks; payment emails retain `AMOUNT` and `UPDATE_PAYMENT_URL`.

Preset checks reject invalid graphs, missing templates or required variables, incompatible send kinds, and missing or bypassed following freshness filters. Payment checks use a finite Stripe input through the existing pure adapter, then validate its actual values against the declared event bindings. Preview samples and optional event schemas are not proof that arbitrary callers supply required values; runtime rendering still rejects missing required variables.

The package exports `presets`, `presetIssues`, `presetFreshness`, `installTopic`, and the `Preset` and `PresetValidation` types. `GET /template-library/automations` lists the six definitions, and `GET /template-library/automations/{slug}` returns one. Template references remain library slugs, and newsletter's `{{topic_id}}` is an installation placeholder. Listing does not install tenant resources. Preset installation and provider receivers are separate features.

## Things to know

- Every template's footer links the tenant's privacy policy when the brand has a `privacy_url`. Set one before sending receipts or invoices.
- A template rendered from code needs a `brand` prop. Without one it uses the sample brand, "Example", which is for previews only, and with `NODE_ENV=production` the render throws.
- Gmail cuts off a message once its HTML passes 102 KB. A receipt or an invoice reaches that at about 100 line items. For longer ones, list the first items and link to the full document.

## Email clients

The matrix has not been run. Nobody has opened these templates in the clients below, with images on or blocked.

| Template | Gmail web | Gmail Android | Gmail iOS | Apple Mail macOS | Apple Mail iOS | Outlook Windows | Outlook.com | Yahoo | Images blocked |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| password-reset | not checked | not checked | not checked | not checked | not checked | not checked | not checked | not checked | not checked |
| verify-email | not checked | not checked | not checked | not checked | not checked | not checked | not checked | not checked | not checked |
| one-time-code | not checked | not checked | not checked | not checked | not checked | not checked | not checked | not checked | not checked |
| magic-link | not checked | not checked | not checked | not checked | not checked | not checked | not checked | not checked | not checked |
| invitation | not checked | not checked | not checked | not checked | not checked | not checked | not checked | not checked | not checked |
| welcome | not checked | not checked | not checked | not checked | not checked | not checked | not checked | not checked | not checked |
| security-notice | not checked | not checked | not checked | not checked | not checked | not checked | not checked | not checked | not checked |
| new-sign-in | not checked | not checked | not checked | not checked | not checked | not checked | not checked | not checked | not checked |
| receipt | not checked | not checked | not checked | not checked | not checked | not checked | not checked | not checked | not checked |
| invoice | not checked | not checked | not checked | not checked | not checked | not checked | not checked | not checked | not checked |
| payment-failed | not checked | not checked | not checked | not checked | not checked | not checked | not checked | not checked | not checked |
| trial-ending | not checked | not checked | not checked | not checked | not checked | not checked | not checked | not checked | not checked |
| order-confirmation | not checked | not checked | not checked | not checked | not checked | not checked | not checked | not checked | not checked |
| shipping-update | not checked | not checked | not checked | not checked | not checked | not checked | not checked | not checked | not checked |
| notification | not checked | not checked | not checked | not checked | not checked | not checked | not checked | not checked | not checked |
| newsletter | not checked | not checked | not checked | not checked | not checked | not checked | not checked | not checked | not checked |
| newsletter-welcome | not checked | not checked | not checked | not checked | not checked | not checked | not checked | not checked | not checked |
| setup-reminder | not checked | not checked | not checked | not checked | not checked | not checked | not checked | not checked | not checked |
| feature-tips | not checked | not checked | not checked | not checked | not checked | not checked | not checked | not checked | not checked |
| upgrade-invite | not checked | not checked | not checked | not checked | not checked | not checked | not checked | not checked | not checked |
| we-miss-you | not checked | not checked | not checked | not checked | not checked | not checked | not checked | not checked | not checked |
| come-back-offer | not checked | not checked | not checked | not checked | not checked | not checked | not checked | not checked | not checked |
| card-update-reminder | not checked | not checked | not checked | not checked | not checked | not checked | not checked | not checked | not checked |
| subscription-canceled | not checked | not checked | not checked | not checked | not checked | not checked | not checked | not checked | not checked |
| confirm-subscription | not checked | not checked | not checked | not checked | not checked | not checked | not checked | not checked | not checked |
