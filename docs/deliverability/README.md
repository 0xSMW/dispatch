# Deliverability

Local v1 focuses on the product controls that protect deliverability before any SES integration:

- verified sender domains before send acceptance
- 50-recipient cap per email
- 40 MB attachment cap after base64 encoding
- tenant suppressions checked before every send
- unsubscribed contacts blocked before send
- bounce and complaint events suppress recipients
- topic subscriptions and static segments for broadcast eligibility
- append-only event timelines for support review

AWS SES account-level suppression, configuration sets, dedicated pools, and quota sync are deployment concerns and remain outside the current local-only scope.

