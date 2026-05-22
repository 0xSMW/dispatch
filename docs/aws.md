# AWS Deployment Notes

AWS deployment comes after the local v1 review. Terraform will provide the reference path for:

- ECS services for API and workers
- RDS Postgres
- Redis-compatible cache
- SQS queues and DLQs
- S3 buckets for content and raw provider payloads
- SES identities, configuration sets, and event destinations
- IAM roles with narrow service permissions

Do not run Terraform against AWS until local v1 has passed review.
