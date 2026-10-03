# Domains

Add and verify a sender domain before sending from it. Dispatch uses Amazon SES for production sending; DNS records authenticate the domain and optionally enable receiving and custom tracking.

For deployment prerequisites, see [AWS](aws.md) and [self-hosting](self-hosting/README.md).

## DNS records

Add a domain under Domains, choose its SES region, and open Records. Copy the exact names, types, values, and priorities Dispatch shows; generated records depend on the domain and region.

| Group | Records and purpose |
|:---|:---|
| DKIM | CNAME records for SES signing. Publish every generated selector. |
| SPF | MX and TXT records for the custom MAIL FROM subdomain, `send.<domain>` by default. The MX handles feedback; the TXT authorizes SES. |
| DMARC | Recommended TXT policy at `_dmarc.<domain>`. The generated starting policy is `v=DMARC1; p=none;`. |
| Receiving | Optional MX at the domain itself, enabled with Receiving. Routes inbound mail to SES in the selected region. |
| Tracking | CNAME at `links.<domain>` by default, targeting the install's configured tracking host. |

At DNS hosts that append the zone name automatically, enter the relative name rather than repeating the domain. Keep DKIM and tracking CNAMEs unproxied so DNS exposes the target.

Do not replace an existing DMARC policy or mailbox MX records without reviewing the consequences. Receiving at a domain can redirect mail away from your existing mailbox provider; use a dedicated subdomain if appropriate. Publishing its MX is not the whole receiving setup: the deployment also needs SES receipt rules, storage, and an inbound queue.

After publishing records:

1. Allow DNS to propagate.
2. Run **Doctor** to inspect what DNS returns for each record and identify missing or incorrect values.
3. Select **Verify DNS** (or **Restart** after a failed attempt). The worker checks SES verification asynchronously; refresh to see progress.

Doctor checks record values; it is not a guarantee of inbox placement. Domain verification does not mean every optional record has passed: inspect individual record statuses.

Changing the tracking subdomain changes the DNS record you need to publish. A verified CNAME alone does not make custom tracking links usable: the deployment must serve that host over HTTPS and enable `TRACKING_CUSTOM_HOSTS=true`. Otherwise links use `PUBLIC_URL`. A localhost tracking target is not suitable for public DNS.

The API exposes domain details at `GET /domains/{id}`, record diagnostics at `GET /domains/{id}/doctor`, and verification at `POST /domains/{id}/verify`. See [the API reference](api/README.md#routes).

## Route 53

If your DNS is in Route 53, use **Publish to Route 53** on the domain's Records tab, or `POST /domains/{id}/publish-route53`.

The API process uses its AWS SDK credentials. It needs `route53:ListHostedZonesByName`, `route53:ListResourceRecordSets`, and `route53:ChangeResourceRecordSets`, scoped appropriately. Dispatch does not create a hosted zone or change nameserver delegation.

The publisher requires a hosted zone whose name exactly matches the Dispatch domain. A parent zone alone does not satisfy a subdomain lookup: publish those records manually in the parent zone or create and delegate the matching subdomain zone.

Publishing uses UPSERT with a TTL of 300 seconds. It can replace existing record sets at the generated names, with these safeguards:

- An existing DMARC record is left unchanged.
- Existing receiving MX records are left unchanged unless the set is already exactly the single generated SES MX record.
- Tracking is skipped when its target is unconfigured or a localhost hostname.

Read the result's hosted zone, records-written count, and skipped records with reasons. Add or resolve skipped records manually, then run Doctor and Verify DNS. Publishing is not verification and does not wait for DNS propagation.

See [AWS credentials and resources](aws.md) for the deployment-side setup.
