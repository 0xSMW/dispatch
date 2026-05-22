# Self-Hosting

The local self-host path is the source of truth before AWS deployment.

```sh
cp .env.example .env
docker compose up -d
pnpm install
pnpm db:migrate
pnpm db:seed
pnpm dev
```

Open:

- API: `http://localhost:3100/health`
- Dashboard: `http://localhost:5173`
- Mailpit: `http://localhost:8025`

Acceptance:

```sh
pnpm run doctor
pnpm smoke
RATE_LIMIT_PER_SECOND=200 pnpm dev:api
pnpm load -- --count 100 --concurrency 20
```

The local provider is fake and stores durable metadata in Postgres. Attachment bytes are stored under `.dispatch/storage`.

