# Security Best Practices Report

## Executive Summary

This pass audited the local Dispatch API, worker, dashboard, SDKs, and examples for the current self-hostable, AWS-native email control plane. The main high-risk classes found were unauthenticated bootstrap/session surfaces, over-broad browser/client trust, tenant-boundary gaps, webhook SSRF and response-exhaustion risk, public tracking amplification, predictable webhook secrets, and operational telemetry consistency. The implemented hardening keeps local development usable while fail-closing production defaults.

## Fixed High Severity

### SEC-1: Public setup and passwordless session surfaces

Impact: production deployments could expose tenant/user metadata or mint long-lived sessions without a real user-auth flow.

Evidence: `/v1/setup` and `/v1/sessions` now use environment-gated defaults that are open for development and closed in production at `apps/api/src/server.ts:149`, `apps/api/src/server.ts:207`, `apps/api/src/server.ts:3456`, and `apps/api/src/server.ts:3460`. Public routes also use pre-auth rate limiting at `apps/api/src/server.ts:154` and `apps/api/src/server.ts:3464`.

Fix: `ALLOW_PUBLIC_SETUP` and `ALLOW_PASSWORDLESS_SESSIONS` default to `false` in production, and public setup/session/tracking routes are rate-limited before auth.

### SEC-2: Tenant authorization and send-key overreach

Impact: send-scoped keys and session users could reach management/read surfaces outside intended permissions.

Evidence: management and operational routes now consistently require full scope, with broad route coverage visible in `apps/api/src/server.ts:234` through `apps/api/src/server.ts:2232`. Send-only behavior is limited to send-oriented endpoints at `apps/api/src/server.ts:1523`, `apps/api/src/server.ts:1530`, `apps/api/src/server.ts:1671`, `apps/api/src/server.ts:1748`, and `apps/api/src/server.ts:1765`.

Fix: management, domain, identity, logs, usage, webhook, inbound, and read/detail endpoints require full scope; send keys are constrained to send/status operations.

### SEC-3: Webhook SSRF and unbounded webhook responses

Impact: tenant-controlled webhook URLs could target local/private infrastructure or exhaust worker memory with large responses.

Evidence: API webhook creation/patch now validates URLs through `apps/api/src/server.ts:1791`, `apps/api/src/server.ts:1837`, `apps/api/src/server.ts:3503`, and DNS-aware host checks at `apps/api/src/server.ts:3523`. The worker repeats validation before dispatch at `apps/worker/src/worker.ts:260`, `apps/worker/src/worker.ts:722`, and `apps/worker/src/worker.ts:735`, disables redirect following at `apps/worker/src/worker.ts:262`, and caps response reads at `apps/worker/src/worker.ts:272` and `apps/worker/src/worker.ts:703`.

Fix: production requires HTTPS, blocks loopback/private/link-local/metadata-style literal and resolved addresses, manually handles redirects, and reads only capped webhook response bodies.

### SEC-4: Browser-stored bearer keys and remote API exfiltration

Impact: dashboard API keys persisted in browser storage or unrestricted API base URLs could expose bearer credentials.

Evidence: old stored dashboard keys are cleared at `apps/dashboard/src/main.tsx:358`, API key inputs are password fields at `apps/dashboard/src/main.tsx:421` and `apps/dashboard/src/main.tsx:689`, and requests use the allowlisted `apiBase` guard at `apps/dashboard/src/main.tsx:2383`, `apps/dashboard/src/main.tsx:2401`, and `apps/dashboard/src/main.tsx:2405`.

Fix: dashboard API keys are memory-only, stale localStorage entries are removed, and remote API origins require explicit opt-in.

## Fixed Medium Severity

### SEC-5: Weak production defaults

Evidence: production startup rejects known development secrets and fake provider usage at `apps/api/src/server.ts:3568`. Local bind defaults are loopback-only via `apps/api/src/server.ts:3607` and `.env.example:6`.

Fix: production fails closed for dev secrets/fake provider; local API and dashboard bind to loopback by default.

### SEC-6: Security headers and request metadata

Evidence: response security headers are set at `apps/api/src/server.ts:140` and `apps/api/src/server.ts:3432`; caller request IDs are constrained at `apps/api/src/server.ts:139` and `apps/api/src/server.ts:3451`; body size is explicit at `apps/api/src/server.ts:112` and `apps/api/src/server.ts:115`; CORS is allowlisted at `apps/api/src/server.ts:127` and `apps/api/src/server.ts:3440`.

Fix: added nosniff, frame-deny, referrer policy, permissions policy, restrictive CSP, bounded request IDs, explicit body limit, and env-based CORS allowlist.

### SEC-7: Tracking, attachment, and inbound storage abuse

Evidence: tracking events fan out only on first token use in the tracking path; inbound raw payloads strip attachment content at `apps/api/src/server.ts:1957` and `apps/api/src/server.ts:3554`; blob reads validate storage-key containment at `apps/api/src/server.ts:3029` and `apps/api/src/server.ts:3034`.

Fix: public tracking no longer repeatedly emits webhook fanout for the same token, inbound raw storage avoids duplicate base64 attachment bodies, and blob paths are root-contained.

### SEC-8: Predictable webhook secrets

Evidence: webhook secrets are generated with `randomBytes(32).toString("base64url")` at `apps/api/src/server.ts:1792`.

Fix: replaced URL/time-derived secrets with cryptographic randomness.

## Supply Chain And SDK Hygiene

Evidence: the lockfile is no longer ignored, Python and Go SDKs fail closed without an API key, and examples require `DISPATCH_API_KEY`. Validation covered `pnpm build`, `pnpm test`, Python byte-compile, Go SDK tests, and both SDK examples.

## Residual Deployment Notes

Static dashboard hosting should preserve the API-equivalent browser security headers at the production edge. The current local Vite development server is loopback-only, but production static hosting must still enforce CSP/frame/referrer/nosniff headers outside this Node API process.
