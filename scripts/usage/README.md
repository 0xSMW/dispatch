# Verification

Dispatch has five named checks: two small guards and three real usage journeys.
Keep this set fixed. Change an existing journey when behavior changes; add a check only by replacing one. Keep executable verification code below 800 physical lines across `scripts/guards.test.ts`, `scripts/usage.ts`, and this directory. Avoid mocks, snapshots, parameter matrices, whole-response golden files, and private API/worker calls.

`pnpm test` runs the two Node guards: malformed password digests fail authentication, and connection-time DNS blocks localhost. `pnpm verify:usage` runs both guards plus sending, audience/consent, and access/clients. The latter uses real curl commands, the product CLI, all three public SDKs, a listening API/worker, Postgres, Redis, file storage, and a loopback webhook receiver. Its SQL connection is read-only.

## Run on home-server

Use an explicitly configured disposable environment. Never load production credentials. Python 3.11+ and Go 1.22+ must be installed alongside the repository's Node/pnpm versions. Supply these variables through the environment's private launcher:

| Variable | Purpose |
| --- | --- |
| `DISPATCH_API_URL` | Running fixture API, loopback HTTP |
| `DISPATCH_API_KEY` | Private full-access fixture key |
| `DATABASE_URL`, `USAGE_DATABASE_URL` | Identical loopback fixture database targets |
| `USAGE_TENANT_ID` | Explicit fixture tenant matched to the API credential and database |
| `USAGE_SENDER` | Sender with a verified domain in that tenant |
| `API_KEY_PEPPER` | Same private pepper used by the fixture API |
| `SES_PROVIDER`, `AWS_REGION` | `fake` and `us-west-2` |
| `USAGE_SOURCE_SHA` | Exact source commit deployed to the fixture environment |
| `USAGE_RESTART_WORKER` | Absolute executable launcher restarting only this environment's worker; sending re-reads durable state afterward |
| `USAGE_EVIDENCE_DIR` | Optional private receipt directory; defaults to `.dispatch/usage` |

The running worker must use the same database/Redis/storage and permit the owned loopback webhook. Run verification serially for each deployed source. Resource names are unique per run. Supporting resources are deleted through public APIs after success; completed imports, sent broadcasts, email/audit history and the separate access-boundary tenant remain as tagged evidence. Failed runs retain fixtures and receipts for diagnosis while retiring their owned webhooks/automations to stop background work. Cleanup never truncates shared tables or deletes another run's resources.

Run `pnpm verify:usage` from the pinned environment launcher. It fails on an unexpected HTTP status, wrong persisted outcome, missing SDK/tool, timeout, or failed cleanup. A mode-600 `summary.json` and command receipts identify all five outcomes, source SHA, fake-provider mode and duration. The target runtime is under five minutes. Do not treat an unavailable environment as a passing check.

## Release practice

Deploy the exact source, compare its hashes, run the five checks, and inspect the persisted outcomes. Verify changed UI in Chrome against the Vercel preview, including a viewer account and reload after mutations. Save an acceptance screenshot; use Chrome Computer Use, never Playwright. More detailed one-off commands may investigate a changed feature without becoming permanent test matrices.

Before retiring a verification path, prove the replacement rejects an actual bad outcome as well as accepting a good run. For example, a sending-only key must make the usage command fail at the first denied setup operation; it must never print success or publish a green status.

CI runs guards, typecheck, build and dependency audit. Its usage job waits for a trusted maintainer's `usage/home-server` commit status on the exact PR head SHA. A maintainer publishes `success` only after that source matches the running environment and `summary.json` records five passed checks. Publish `pending` at the start and `failure`/`error` after an unsuccessful run. The hosted job has no private network credentials; it trusts repository status writers and fails when the receipt is absent or unsuccessful.

Fake-provider and sandbox outcomes do not prove SES/SNS delivery. Controlled real-provider acceptance, including raw MIME/CID handling when relevant, is a separate explicitly authorized release exercise in `us-west-2`.
