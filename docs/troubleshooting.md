# Troubleshooting

Start with:

```sh
pnpm run doctor
```

It checks the local service ports, API health, setup, worker backlog, webhook queue, domains, emails, and webhooks. Use these for deeper inspection:

```sh
pnpm --filter @dispatch/cli start -- system
pnpm --filter @dispatch/cli start -- timeline
pnpm --filter @dispatch/cli start -- logs export
pnpm --filter @dispatch/cli start -- listen --port 8787
```

Common local issues:

- Docker is not running.
- Postgres is not ready on `localhost:5432`.
- Redis is not ready on `localhost:6379`.
- Migrations have not been applied.
- The seed command has not created a tenant and key.
- The worker is not running, so emails remain queued.
