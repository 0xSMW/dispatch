# Templates

`@dispatchmail/templates` contains 25 emails in Dispatch's template library, including lifecycle and subscription confirmation emails. The components are in `emails/`. Building the package writes `library.json`, and that file is what the API installs. Nothing in this package sends mail.

## Preview

From the repo root:

```
pnpm --filter @dispatchmail/templates exec email dev --dir emails
```

Folders whose names start with `_` stay out of the preview sidebar.

## Build checks

The build checks each template's content, variables, Transactional or Marketing kind, lifecycle stage, and when-to-use guidance before writing the library. Marketing templates need an unsubscribe link and company address in both HTML and plain text. Lifecycle emails use recipient-name fallbacks; payment emails retain `AMOUNT` and `UPDATE_PAYMENT_URL`.

Templates alone do not install lifecycle automation graphs. Preset installation and provider receivers are separate features.

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
