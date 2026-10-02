# AWS

Dispatch talks to SES, SQS, S3, and Route 53 through the AWS SDK. Credentials come from the SDK's default chain: environment variables, a shared profile, or an instance or task role.

There is no reference deployment. `infra/terraform` holds an empty `dispatch` module that creates nothing. Do not expect it to provision ECS, RDS, queues, or SES resources. [Self-hosting](self-hosting/README.md) lists what a deployment has to set up by hand.

## Calls Dispatch makes

| Service | Calls | Process | When |
|:---|:---|:---|:---|
| SES v2 | `CreateEmailIdentity`, `PutEmailIdentityMailFromAttributes` | API | `POST /domains` with `SES_PROVIDER=ses` |
| SES v2 | `DeleteEmailIdentity` | API | `DELETE /domains/{id}` with `SES_PROVIDER=ses` |
| SES v2 | `GetEmailIdentity` | worker | polling pending domains with `SES_PROVIDER=ses` |
| SES v2 | `SendEmail` | worker | every send with `SES_PROVIDER=ses`, including mail that came in through the SMTP relay |
| SES v2 | `GetAccount` | API | `GET /system` with `SES_PROVIDER=ses` |
| SQS | `ReceiveMessage`, `DeleteMessage` | worker | when `SES_EVENTS_QUEUE_URL` or `SES_INBOUND_QUEUE_URL` is set |
| S3 | `PutObject`, `GetObject`, `DeleteObject`, presigned `GetObject` URLs | API, worker, SMTP relay | `STORAGE_BACKEND=s3` |
| Route 53 | `ListHostedZonesByName`, `ListResourceRecordSets`, `ChangeResourceRecordSets` | API | `POST /domains/{id}/publish-route53` |

Grant each process the actions in its rows, scoped to your bucket, queues, and hosted zones where IAM allows it. The SMTP relay needs the S3 actions, because it stores the attachments of the mail it accepts.

## Resources you create

- SES configuration sets `dispatch-default` and `dispatch-tls-required` in each sending region, with an event destination that reaches the events queue. Dispatch names them on every send and never creates them.
- An SQS queue for SES events (`SES_EVENTS_QUEUE_URL`). Messages must be the raw SES event JSON, so turn on raw message delivery if SNS delivers them.
- For receiving: an SES receipt rule set in `SES_INBOUND_REGION`, a rule with an S3 action that writes to `S3_BUCKET` under `raw/` and notifies SNS, and an SQS queue subscribed with raw delivery (`SES_INBOUND_QUEUE_URL`).
- An S3 bucket for `STORAGE_BACKEND=s3`.
- Route 53 hosted zones, if you want `publish-route53`. The client always calls Route 53 in `us-east-1`, which is where Route 53's API lives.

Domains can be created in `us-east-1`, `eu-west-1`, `sa-east-1`, or `ap-northeast-1`. Receiving needs a region where SES receives mail. All four do.
