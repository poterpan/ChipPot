# ChipPo

訂閱代管收費系統 — 100% serverless on Cloudflare (Workers + D1 + R2 + Cron + Access),
core/adapter split (Discord first, LINE/Telegram later), multi-workspace ready.

> Plans & architecture: `docs/superpowers/plans/`. Conventions and deviations:
> `2026-05-31-chippo-master-roadmap.md`.

## Prerequisites

- Node.js 22+, pnpm 10+
- wrangler 4.x authenticated (`wrangler login`) to the target Cloudflare account

## Repo layout

```
packages/worker   Cloudflare Worker: API, Discord interactions, upload, cron
packages/web      (Phase 5) Vite+React public upload page (Pages)
packages/admin    (Phase 6) Vite+React admin UI (Pages, behind Access)
```

## Develop

```bash
pnpm install                                   # installs all workspaces
pnpm --filter @chippo/worker test              # run worker test suite (Vitest + Miniflare D1)
pnpm --filter @chippo/worker typecheck         # tsc --noEmit
pnpm --filter @chippo/worker migrate:local     # apply migrations to local D1
pnpm --filter @chippo/worker dev               # wrangler dev (local)
```

Tests run inside the Workers runtime via `@cloudflare/vitest-pool-workers` with a real
local D1. **Storage isolation is per test file** (see roadmap testing conventions).

## Cloudflare resources (provisioned)

| Resource | Name | Notes |
|---|---|---|
| D1 database | `chippo-db` | id `9ebe144c-13d4-4a10-a050-81235307e788` (APAC); in `wrangler.toml` |
| R2 bucket | `chippo-proofs` | private (never make public); payment screenshots |

To (re)provision from scratch:

```bash
wrangler d1 create chippo-db                   # copy database_id into wrangler.toml
wrangler r2 bucket create chippo-proofs        # private by default
pnpm --filter @chippo/worker migrate:remote    # apply schema + seed to remote D1
wrangler d1 execute chippo-db --remote --command "SELECT name, monthly_amount FROM plans"
```

Secrets (added in later phases) go via `wrangler secret put` or a gitignored `.dev.vars`
— never commit them. A full deploy runbook (Pages, Access, Cron, Discord registration)
lands in Phase 8.
