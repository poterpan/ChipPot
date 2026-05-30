# ChipPo Phase 1 — Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking. See the master roadmap
> `2026-05-31-chippo-master-roadmap.md` for architecture, conventions, and deviations.

**Goal:** Stand up the pnpm monorepo + Cloudflare Worker package with a tested data
layer: full D1 schema + seed, and the channel-agnostic utilities `time`, `tokens`,
`audit`, plus `env`/settings parsing and minimal `db` helpers — all under Vitest with
real D1/R2 via `@cloudflare/vitest-pool-workers`.

**Architecture:** Single Worker package (`packages/worker`). Migrations bootstrap a
usable system. Core utilities are pure/injectable and unit-tested against a real local
D1. No HTTP, Discord, or frontend yet.

**Tech stack:** TypeScript, Cloudflare Workers, D1, R2, Vitest + vitest-pool-workers,
pnpm workspace, wrangler 4.x.

> **Testing conventions (verified empirically — apply to ALL DB tests, every phase):**
> 1. **Storage isolation is per test FILE, not per test.** Writes accumulate across
>    `it` blocks within a file and roll back only at file end. Design each file to be
>    collision-free: seed shared parents once in `beforeAll`, and vary unique keys
>    (e.g. `period`) per `it`. (`isolatedStorage`/`singleWorker` no longer exist.)
> 2. **Miniflare's D1 enforces FOREIGN KEY constraints.** Inserts must create parent
>    rows first (workspace → user/plan → subscription → payment).
> 3. **Tests that mutate use a distinct id-space** (e.g. workspace `9001`) so they never
>    collide with the seeded workspace (id `1`) present in every file's base.
> 4. Always `await` every storage op; consume any response bodies.

---

### Task 1: Monorepo + Worker scaffold + test harness

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `.gitignore`
- Create: `packages/worker/package.json`, `packages/worker/tsconfig.json`,
  `packages/worker/wrangler.toml`, `packages/worker/vitest.config.ts`
- Create: `packages/worker/src/index.ts`, `packages/worker/src/env.ts`
- Create: `packages/worker/test/apply-migrations.ts`, `packages/worker/test/env.d.ts`
- Create: `packages/worker/migrations/0001_init.sql` (empty placeholder, filled Task 2)
- Test: `packages/worker/test/smoke.test.ts`

- [ ] **Step 1: Initialize git + root workspace files**

`git init` at repo root. Create root `package.json`:

```json
{
  "name": "chippo",
  "private": true,
  "packageManager": "pnpm@10.33.0",
  "scripts": {
    "test": "pnpm -r test",
    "typecheck": "pnpm -r typecheck"
  }
}
```

Add a `pnpm` allowlist so native build scripts (esbuild/workerd) run under pnpm 10
(they are blocked by default and the test runtime needs them):

```json
  "pnpm": {
    "onlyBuiltDependencies": ["esbuild", "workerd", "sharp"]
  }
```

`pnpm-workspace.yaml`:

```yaml
packages:
  - "packages/*"
```

`.gitignore`:

```
node_modules/
dist/
.wrangler/
.dev.vars
*.local
.DS_Store
coverage/
```

- [ ] **Step 2: Worker package manifest + deps**

`packages/worker/package.json`:

```json
{
  "name": "@chippo/worker",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "migrate:local": "wrangler d1 migrations apply chippo-db --local",
    "migrate:remote": "wrangler d1 migrations apply chippo-db --remote"
  },
  "devDependencies": {
    "@cloudflare/vitest-pool-workers": "^0.16.10",
    "@cloudflare/workers-types": "^4.20250101.0",
    "typescript": "^5.7.0",
    "vitest": "^4.1.0",
    "wrangler": "^4.69.0"
  }
}
```

> **Toolchain note (verified against installed wrangler 4.69):** `vitest-pool-workers`
> `0.16.x` requires **vitest `^4.1.0`** and bundles the miniflare/workerd generation
> matching wrangler 4.69. Older `0.9.x` (vitest 3.2) bundles a different workerd and
> fails with `vm._setUnsafeEval is not a function`. The `0.16` line also **renamed the
> config API** (see Step 5). Install from repo root: `pnpm install`.

- [ ] **Step 3: tsconfig + wrangler.toml + entry**

`packages/worker/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "types": ["@cloudflare/workers-types", "@cloudflare/vitest-pool-workers"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "skipLibCheck": true,
    "noEmit": true,
    "esModuleInterop": true
  },
  "include": ["src", "test"]
}
```

`packages/worker/wrangler.toml`:

```toml
name = "chippo"
main = "src/index.ts"
compatibility_date = "2025-11-01"
compatibility_flags = ["nodejs_compat"]

# database_id is a placeholder for local/test; real id is set at Phase 1 deploy.
[[d1_databases]]
binding = "DB"
database_name = "chippo-db"
database_id = "00000000-0000-0000-0000-000000000000"
migrations_dir = "migrations"

[[r2_buckets]]
binding = "BUCKET"
bucket_name = "chippo-proofs"

# 01:00 UTC = 09:00 Asia/Taipei, daily.
[triggers]
crons = ["0 1 * * *"]
```

`packages/worker/src/index.ts`:

```ts
import type { Env } from "./env";

export default {
  async fetch(_req: Request, _env: Env): Promise<Response> {
    return new Response("ChipPo worker", { status: 200 });
  },
  async scheduled(_event: ScheduledController, _env: Env): Promise<void> {
    // Cron handler implemented in Phase 7.
  },
} satisfies ExportedHandler<Env>;
```

- [ ] **Step 4: env.ts (Env binding type only for now)**

`packages/worker/src/env.ts`:

```ts
export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
}
```

- [ ] **Step 5: Vitest pool-workers config + migration setup**

`packages/worker/vitest.config.ts` — **vitest-4 / pool-workers-0.16 shape**: there is no
`defineWorkersConfig`; instead wrap the old `workers` options in the `cloudflareTest()`
Vite **plugin** and use `defineConfig` from `vitest/config`. `readD1Migrations` is now
exported from the package root:

```ts
import path from "node:path";
import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(__dirname, "migrations"));
  return {
    plugins: [
      cloudflareTest({
        singleWorker: true,
        isolatedStorage: true,
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          bindings: { TEST_MIGRATIONS: migrations },
        },
      }),
    ],
    test: {
      setupFiles: ["./test/apply-migrations.ts"],
    },
  };
});
```

`packages/worker/test/apply-migrations.ts`:

```ts
import { applyD1Migrations, env } from "cloudflare:test";

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
```

`packages/worker/test/env.d.ts` — in vitest-4 `cloudflare:test`'s `env` is typed as
`Cloudflare.Env` (no more `ProvidedEnv`). Extend it from the single app binding source
and add the test-only migration binding (we keep `@cloudflare/workers-types` for runtime
globals instead of committing the 512 KB `wrangler types` output):

```ts
/// <reference types="@cloudflare/vitest-pool-workers/types" />
import type { D1Migration } from "@cloudflare/vitest-pool-workers";
import type { Env as AppEnv } from "../src/env";

declare global {
  namespace Cloudflare {
    interface Env extends AppEnv {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
```

- [ ] **Step 6: Placeholder migration so the harness has something to read**

Create `packages/worker/migrations/0001_init.sql` with a single comment line
`-- ChipPo schema (filled in Task 2)`. (Filled with real DDL in Task 2.)

- [ ] **Step 7: Write the smoke test**

`packages/worker/test/smoke.test.ts`:

```ts
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("test harness", () => {
  it("binds D1 and R2", () => {
    expect(env.DB).toBeDefined();
    expect(env.BUCKET).toBeDefined();
  });
});
```

- [ ] **Step 8: Run the smoke test**

Run: `pnpm --filter @chippo/worker test`
Expected: PASS (1 test). This proves pnpm + vitest-pool-workers + wrangler.toml +
migration reader are all wired. If `readD1Migrations` errors on the comment-only file,
add a no-op statement `SELECT 1;` to `0001_init.sql` temporarily.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "chore: scaffold pnpm monorepo + worker package with vitest-pool-workers"
```

---

### Task 2: D1 schema migration (all tables, constraints, indexes)

**Files:**
- Modify: `packages/worker/migrations/0001_init.sql` (replace placeholder with full DDL)
- Test: `packages/worker/test/schema.test.ts`

- [ ] **Step 1: Write the failing schema test**

`packages/worker/test/schema.test.ts` — follows the per-file isolation + FK + distinct
id-space conventions above (seed parents once in `beforeAll` under workspace `9001`,
distinct `period` per `it`):

```ts
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

const TABLES = [
  "workspaces", "users", "plans", "channel_tags", "subscriptions",
  "payments", "upload_tokens", "notification_logs", "audit_logs",
];
const TS = "2026-05-01T00:00:00.000Z";
const WS = 9001;

beforeAll(async () => {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO workspaces (id, name, owner_id, channel_type, billing_day, settings, created_at, updated_at)
       VALUES (?, 'W', 'owner', 'discord', 5, '{}', ?, ?)`
    ).bind(WS, TS, TS),
    env.DB.prepare(
      `INSERT INTO users (id, workspace_id, display_name, created_at, updated_at)
       VALUES (?, ?, 'U', ?, ?)`
    ).bind(WS, WS, TS, TS),
    env.DB.prepare(
      `INSERT INTO plans (id, workspace_id, name, provider, monthly_amount, created_at, updated_at)
       VALUES (?, ?, 'P', 'openai', 315, ?, ?)`
    ).bind(WS, WS, TS, TS),
    env.DB.prepare(
      `INSERT INTO subscriptions (id, workspace_id, user_id, plan_id, start_date, billing_day, created_at, updated_at)
       VALUES (?, ?, ?, ?, '2026-05-01', 5, ?, ?)`
    ).bind(WS, WS, WS, WS, TS, TS),
  ]);
});

function insertPayment(status: string, period: string) {
  return env.DB.prepare(
    `INSERT INTO payments
       (workspace_id, subscription_id, period, period_start, period_end, due_date,
        amount, status, source, created_at, updated_at)
     VALUES (?, ?, ?, '2026-05-01', '2026-05-31', '2026-05-05', 315, ?, 'cron', ?, ?)`
  ).bind(WS, WS, period, status, TS, TS).run();
}

describe("schema", () => {
  it("creates all tables", async () => {
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all<{ name: string }>();
    const names = results.map((r) => r.name);
    for (const t of TABLES) expect(names).toContain(t);
  });

  it("enforces payments status CHECK", async () => {
    await expect(insertPayment("BOGUS", "2026-01")).rejects.toThrow();
  });

  it("accepts a valid payments status", async () => {
    await expect(insertPayment("pending", "2026-02")).resolves.toBeDefined();
  });

  it("enforces UNIQUE(subscription_id, period) on payments", async () => {
    await insertPayment("pending", "2026-03");
    await expect(insertPayment("pending", "2026-03")).rejects.toThrow();
  });

  it("dedupes notification_logs via NOT NULL DEFAULT 0 sentinels", async () => {
    const ins = () =>
      env.DB.prepare(
        `INSERT INTO notification_logs (workspace_id, type, period, sent_at)
         VALUES (?, 'billing_opened', '2026-04', '2026-04-05T01:00:00.000Z')`
      ).bind(WS).run();
    await ins();
    await expect(ins()).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @chippo/worker test schema`
Expected: FAIL (tables/constraints missing).

- [ ] **Step 3: Write the full schema**

Replace `packages/worker/migrations/0001_init.sql` entirely with:

```sql
-- ChipPo D1 schema v2. Conventions: timestamps = UTC ISO millis TEXT;
-- business dates = YYYY-MM-DD (Asia/Taipei); period = YYYY-MM; amounts = INTEGER TWD;
-- booleans = INTEGER + CHECK (col IN (0,1)).

CREATE TABLE workspaces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  channel_type TEXT NOT NULL CHECK (channel_type IN ('discord','line','telegram')),
  billing_day INTEGER NOT NULL DEFAULT 5 CHECK (billing_day BETWEEN 1 AND 28),
  settings TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id),
  discord_id TEXT,
  display_name TEXT NOT NULL,
  email TEXT,
  note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(workspace_id, discord_id)
);

CREATE TABLE plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id),
  name TEXT NOT NULL,
  provider TEXT NOT NULL,
  monthly_amount INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'TWD' CHECK (currency = 'TWD'),
  billing_cycle TEXT NOT NULL DEFAULT 'monthly' CHECK (billing_cycle IN ('monthly','yearly')),
  split_count INTEGER,
  discord_role_id TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE channel_tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id),
  name TEXT NOT NULL,
  type TEXT CHECK (type IN ('linepay','bank','other')),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  plan_id INTEGER NOT NULL REFERENCES plans(id),
  start_date TEXT NOT NULL,
  billing_day INTEGER NOT NULL CHECK (billing_day BETWEEN 1 AND 28),
  custom_cycle INTEGER NOT NULL DEFAULT 0 CHECK (custom_cycle IN (0,1)),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','cancelled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id),
  subscription_id INTEGER NOT NULL REFERENCES subscriptions(id),
  period TEXT NOT NULL,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  due_date TEXT NOT NULL,
  amount INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','verified','rejected')),
  has_proof INTEGER NOT NULL DEFAULT 0 CHECK (has_proof IN (0,1)),
  screenshot_key TEXT,
  proof_deleted_at TEXT,
  payment_note TEXT,
  verified_channel_tag_id INTEGER REFERENCES channel_tags(id),
  source TEXT NOT NULL DEFAULT 'user'
    CHECK (source IN ('user','user_slash','user_web','admin_manual','cron')),
  rejected_reason TEXT,
  submitted_at TEXT,
  paid_at TEXT,
  verified_by TEXT,
  verified_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(subscription_id, period)
);

CREATE TABLE upload_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash TEXT UNIQUE NOT NULL,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  period TEXT NOT NULL,
  subscription_id INTEGER REFERENCES subscriptions(id),
  used_at TEXT,
  used_by_source TEXT,
  revoked_at TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Dedup columns are NOT NULL DEFAULT 0 (sentinel) because SQLite treats NULLs as
-- distinct in UNIQUE, which would defeat dedup. See roadmap §4.1.
CREATE TABLE notification_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('billing_opened','overdue','receipt')),
  period TEXT NOT NULL,
  plan_id INTEGER NOT NULL DEFAULT 0,
  user_id INTEGER NOT NULL DEFAULT 0,
  subscription_id INTEGER NOT NULL DEFAULT 0,
  external_channel_type TEXT,
  external_message_id TEXT,
  sent_at TEXT NOT NULL,
  UNIQUE(workspace_id, type, period, plan_id, user_id, subscription_id)
);

CREATE TABLE audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  before_json TEXT,
  after_json TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_payments_workspace_period_status
  ON payments(workspace_id, period, status);
CREATE INDEX idx_payments_subscription_period
  ON payments(subscription_id, period);
CREATE INDEX idx_subscriptions_workspace_status
  ON subscriptions(workspace_id, status);
CREATE INDEX idx_users_workspace ON users(workspace_id);
CREATE INDEX idx_audit_logs_entity ON audit_logs(workspace_id, entity_type, entity_id);
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @chippo/worker test schema`
Expected: PASS (5 tests). Miniflare's D1 **does** enforce FK constraints, which is why
the test seeds real parents (workspace `9001` → user → plan → subscription) before
inserting payments.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(db): full D1 schema with constraints and indexes"
```

---

### Task 3: Seed migration (workspace + plans + channel_tags)

**Files:**
- Create: `packages/worker/migrations/0002_seed.sql`
- Test: `packages/worker/test/seed.test.ts`

- [ ] **Step 1: Write the failing seed test**

`packages/worker/test/seed.test.ts`:

```ts
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("seed", () => {
  it("creates the club workspace with discord channel + billing_day 5", async () => {
    const ws = await env.DB.prepare(
      "SELECT name, channel_type, billing_day, settings FROM workspaces WHERE id = 1"
    ).first<{ name: string; channel_type: string; billing_day: number; settings: string }>();
    expect(ws?.channel_type).toBe("discord");
    expect(ws?.billing_day).toBe(5);
    const settings = JSON.parse(ws!.settings);
    expect(settings.timezone).toBe("Asia/Taipei");
    expect(settings.overdue_days).toBe(3);
    expect(settings.proof_retention_months).toBe(24);
  });

  it("seeds the three plans with correct TWD prices", async () => {
    const { results } = await env.DB.prepare(
      "SELECT name, provider, monthly_amount FROM plans WHERE workspace_id = 1 ORDER BY id"
    ).all<{ name: string; provider: string; monthly_amount: number }>();
    expect(results).toEqual([
      { name: "ChatGPT", provider: "openai", monthly_amount: 315 },
      { name: "Claude Standard", provider: "anthropic", monthly_amount: 251 },
      { name: "Claude Premium", provider: "anthropic", monthly_amount: 1258 },
    ]);
  });

  it("seeds example channel_tags", async () => {
    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM channel_tags WHERE workspace_id = 1"
    ).first<{ n: number }>();
    expect(row!.n).toBeGreaterThanOrEqual(1);
  });
});
```
(Also assert `settings.delete_discord_original_message === false`.)

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @chippo/worker test seed`
Expected: FAIL (no rows seeded).

- [ ] **Step 3: Write the seed migration**

`packages/worker/migrations/0002_seed.sql`:

```sql
-- Bootstrap one workspace, its plans, and example channel tags.
-- created_at uses SQLite strftime millis (acceptable for fixtures).
-- settings is a literal JSON string (unambiguous boolean handling).

INSERT INTO workspaces (id, name, owner_id, channel_type, billing_day, settings, created_at, updated_at)
VALUES (
  1, '社團 AI 訂閱', 'poterpan5466@gmail.com', 'discord', 5,
  '{"timezone":"Asia/Taipei","discord_guild_id":"","discord_billing_channel_id":"","discord_payment_message_id":"","overdue_days":3,"delete_discord_original_message":false,"proof_retention_months":24}',
  strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')
);

INSERT INTO plans (workspace_id, name, provider, monthly_amount, created_at, updated_at) VALUES
  (1, 'ChatGPT',         'openai',    315,  strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  (1, 'Claude Standard', 'anthropic', 251,  strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  (1, 'Claude Premium',  'anthropic', 1258, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'));

INSERT INTO channel_tags (workspace_id, name, type, sort_order, created_at) VALUES
  (1, 'LINE Pay',      'linepay', 1, strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  (1, '銀行轉帳-國泰', 'bank',    2, strftime('%Y-%m-%dT%H:%M:%fZ','now'));
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @chippo/worker test seed`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(db): seed workspace, plans, and example channel tags"
```

---

### Task 4: `core/time.ts` — Asia/Taipei business dates + UTC ISO

**Files:**
- Create: `packages/worker/src/core/time.ts`
- Test: `packages/worker/test/core/time.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/worker/test/core/time.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  nowUtcIso, taipeiDate, taipeiPeriod, taipeiDayOfMonth,
  periodStart, periodEnd, dueDate, daysBetween,
} from "../../src/core/time";

describe("time", () => {
  it("nowUtcIso returns UTC ISO with millis", () => {
    expect(nowUtcIso(new Date("2026-05-31T12:00:00.000Z"))).toBe("2026-05-31T12:00:00.000Z");
  });

  it("taipeiDate rolls to next day across UTC midnight (UTC+8)", () => {
    // 17:30 UTC = 01:30 next day in Taipei
    expect(taipeiDate(new Date("2026-05-31T17:30:00.000Z"))).toBe("2026-06-01");
    // 15:59 UTC = 23:59 same day in Taipei
    expect(taipeiDate(new Date("2026-05-31T15:59:00.000Z"))).toBe("2026-05-31");
  });

  it("taipeiPeriod / taipeiDayOfMonth cross year boundary", () => {
    const d = new Date("2026-12-31T16:30:00.000Z"); // Taipei 2027-01-01 00:30
    expect(taipeiPeriod(d)).toBe("2027-01");
    expect(taipeiDayOfMonth(d)).toBe(1);
  });

  it("periodStart / periodEnd handle month lengths and leap years", () => {
    expect(periodStart("2026-05")).toBe("2026-05-01");
    expect(periodEnd("2026-02")).toBe("2026-02-28");
    expect(periodEnd("2024-02")).toBe("2024-02-29");
    expect(periodEnd("2026-12")).toBe("2026-12-31");
  });

  it("dueDate pads billing_day", () => {
    expect(dueDate("2026-05", 5)).toBe("2026-05-05");
    expect(dueDate("2026-05", 28)).toBe("2026-05-28");
  });

  it("daysBetween counts whole days", () => {
    expect(daysBetween("2026-05-05", "2026-05-09")).toBe(4);
    expect(daysBetween("2026-05-09", "2026-05-05")).toBe(-4);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @chippo/worker test time`
Expected: FAIL ("Cannot find module ../../src/core/time").

- [ ] **Step 3: Implement `core/time.ts`**

```ts
const TZ = "Asia/Taipei";

/** UTC ISO 8601 with milliseconds, e.g. 2026-05-30T12:34:56.000Z */
export function nowUtcIso(d: Date = new Date()): string {
  return d.toISOString();
}

function taipeiParts(d: Date): { y: string; m: string; d: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return { y: get("year"), m: get("month"), d: get("day") };
}

/** YYYY-MM-DD in Asia/Taipei for the given instant. */
export function taipeiDate(d: Date = new Date()): string {
  const { y, m, d: day } = taipeiParts(d);
  return `${y}-${m}-${day}`;
}

/** YYYY-MM in Asia/Taipei. */
export function taipeiPeriod(d: Date = new Date()): string {
  return taipeiDate(d).slice(0, 7);
}

/** Day-of-month (1-31) in Asia/Taipei. */
export function taipeiDayOfMonth(d: Date = new Date()): number {
  return Number(taipeiDate(d).slice(8, 10));
}

/** First day of a YYYY-MM period. */
export function periodStart(period: string): string {
  return `${period}-01`;
}

/** Last day of a YYYY-MM period (handles 28/29/30/31). */
export function periodEnd(period: string): string {
  const [y, m] = period.split("-").map(Number);
  const last = new Date(Date.UTC(y!, m!, 0)).getUTCDate(); // day 0 of next month
  return `${period}-${String(last).padStart(2, "0")}`;
}

/** Due date = billing_day within the period. billing_day is constrained 1..28. */
export function dueDate(period: string, billingDay: number): string {
  return `${period}-${String(billingDay).padStart(2, "0")}`;
}

/** Whole days from fromDate to toDate (both YYYY-MM-DD); negative if toDate earlier. */
export function daysBetween(fromDate: string, toDate: string): number {
  const a = Date.parse(`${fromDate}T00:00:00Z`);
  const b = Date.parse(`${toDate}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @chippo/worker test time`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(core): Asia/Taipei business-date and UTC ISO time utilities"
```

---

### Task 5: `core/tokens.ts` — one-time token gen + sha256 hash

**Files:**
- Create: `packages/worker/src/core/tokens.ts`
- Test: `packages/worker/test/core/tokens.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/worker/test/core/tokens.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { generateToken, hashToken } from "../../src/core/tokens";

describe("tokens", () => {
  it("generates a 64-char lowercase hex token (32 bytes)", () => {
    const t = generateToken();
    expect(t).toMatch(/^[0-9a-f]{64}$/);
  });

  it("generates unique tokens", () => {
    expect(generateToken()).not.toBe(generateToken());
  });

  it("hashToken matches a known SHA-256 vector", async () => {
    // SHA-256("abc")
    expect(await hashToken("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
  });

  it("hashToken is deterministic", async () => {
    const t = generateToken();
    expect(await hashToken(t)).toBe(await hashToken(t));
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @chippo/worker test tokens`
Expected: FAIL ("Cannot find module ../../src/core/tokens").

- [ ] **Step 3: Implement `core/tokens.ts`**

```ts
function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** 32 random bytes as 64 lowercase hex chars. Raw token goes in the URL. */
export function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return toHex(bytes);
}

/** sha256(raw) as 64 lowercase hex chars. Only this is stored in D1. */
export async function hashToken(raw: string): Promise<string> {
  const data = new TextEncoder().encode(raw);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return toHex(new Uint8Array(digest));
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @chippo/worker test tokens`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(core): one-time token generation and sha256 hashing"
```

---

### Task 6: `core/db.ts` — row types + minimal getters

**Files:**
- Create: `packages/worker/src/core/db.ts`
- Test: `packages/worker/test/core/db.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/worker/test/core/db.test.ts`:

```ts
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { getWorkspace, getActivePlans } from "../../src/core/db";

describe("db getters", () => {
  it("getWorkspace returns the seeded workspace", async () => {
    const ws = await getWorkspace(env.DB, 1);
    expect(ws?.name).toBe("社團 AI 訂閱");
    expect(ws?.channel_type).toBe("discord");
  });

  it("getWorkspace returns null for unknown id", async () => {
    expect(await getWorkspace(env.DB, 9999)).toBeNull();
  });

  it("getActivePlans returns the three seeded plans", async () => {
    const plans = await getActivePlans(env.DB, 1);
    expect(plans.map((p) => p.name)).toEqual([
      "ChatGPT", "Claude Standard", "Claude Premium",
    ]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @chippo/worker test core/db`
Expected: FAIL ("Cannot find module ../../src/core/db").

- [ ] **Step 3: Implement `core/db.ts`**

```ts
export interface WorkspaceRow {
  id: number;
  name: string;
  owner_id: string;
  channel_type: string;
  billing_day: number;
  settings: string;
  created_at: string;
  updated_at: string;
}

export interface PlanRow {
  id: number;
  workspace_id: number;
  name: string;
  provider: string;
  monthly_amount: number;
  currency: string;
  billing_cycle: string;
  split_count: number | null;
  discord_role_id: string | null;
  active: number;
  created_at: string;
  updated_at: string;
}

export async function getWorkspace(
  db: D1Database,
  id: number
): Promise<WorkspaceRow | null> {
  return db
    .prepare("SELECT * FROM workspaces WHERE id = ?")
    .bind(id)
    .first<WorkspaceRow>();
}

export async function getActivePlans(
  db: D1Database,
  workspaceId: number
): Promise<PlanRow[]> {
  const { results } = await db
    .prepare(
      "SELECT * FROM plans WHERE workspace_id = ? AND active = 1 ORDER BY id"
    )
    .bind(workspaceId)
    .all<PlanRow>();
  return results;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @chippo/worker test core/db`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(core): row types and minimal D1 getters"
```

---

### Task 7: `core/audit.ts` — audit_logs writer

**Files:**
- Create: `packages/worker/src/core/audit.ts`
- Test: `packages/worker/test/core/audit.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/worker/test/core/audit.test.ts`:

```ts
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { writeAudit } from "../../src/core/audit";

describe("writeAudit", () => {
  it("inserts an audit row with JSON before/after and UTC ISO created_at", async () => {
    await writeAudit(env.DB, {
      workspaceId: 1,
      actor: "owner@example.com",
      action: "amount.override",
      entityType: "payment",
      entityId: 42,
      before: { amount: 315 },
      after: { amount: 300 },
    });

    const row = await env.DB.prepare(
      `SELECT actor, action, entity_type, entity_id, before_json, after_json, created_at
       FROM audit_logs WHERE entity_type = 'payment' AND entity_id = 42`
    ).first<{
      actor: string; action: string; entity_type: string; entity_id: number;
      before_json: string; after_json: string; created_at: string;
    }>();

    expect(row?.action).toBe("amount.override");
    expect(JSON.parse(row!.before_json)).toEqual({ amount: 315 });
    expect(JSON.parse(row!.after_json)).toEqual({ amount: 300 });
    expect(row!.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("accepts null before/after", async () => {
    await writeAudit(env.DB, {
      workspaceId: 1,
      actor: "system",
      action: "proof.auto_delete",
      entityType: "payment",
      entityId: 7,
    });
    const row = await env.DB.prepare(
      "SELECT before_json, after_json FROM audit_logs WHERE entity_id = 7"
    ).first<{ before_json: string | null; after_json: string | null }>();
    expect(row?.before_json).toBeNull();
    expect(row?.after_json).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @chippo/worker test audit`
Expected: FAIL ("Cannot find module ../../src/core/audit").

- [ ] **Step 3: Implement `core/audit.ts`**

```ts
import { nowUtcIso } from "./time";

export interface AuditEntry {
  workspaceId: number;
  actor: string;
  action: string;
  entityType: string;
  entityId: number;
  before?: unknown;
  after?: unknown;
}

/** Append an audit_logs row. All admin mutations must call this. */
export async function writeAudit(db: D1Database, e: AuditEntry): Promise<void> {
  await db
    .prepare(
      `INSERT INTO audit_logs
        (workspace_id, actor, action, entity_type, entity_id, before_json, after_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      e.workspaceId,
      e.actor,
      e.action,
      e.entityType,
      e.entityId,
      e.before === undefined ? null : JSON.stringify(e.before),
      e.after === undefined ? null : JSON.stringify(e.after),
      nowUtcIso()
    )
    .run();
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @chippo/worker test audit`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(core): audit_logs writer for admin mutations"
```

---

### Task 8: `env.ts` settings parsing + validation

**Files:**
- Modify: `packages/worker/src/env.ts`
- Test: `packages/worker/test/env.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/worker/test/env.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseSettings, DEFAULT_SETTINGS } from "../src/env";

describe("parseSettings", () => {
  it("fills defaults for missing keys", () => {
    const s = parseSettings("{}");
    expect(s).toEqual(DEFAULT_SETTINGS);
  });

  it("overrides provided keys and coerces types", () => {
    const s = parseSettings(JSON.stringify({
      overdue_days: 5,
      proof_retention_months: 12,
      delete_discord_original_message: true,
      discord_guild_id: "123",
    }));
    expect(s.overdue_days).toBe(5);
    expect(s.proof_retention_months).toBe(12);
    expect(s.delete_discord_original_message).toBe(true);
    expect(s.discord_guild_id).toBe("123");
    expect(s.timezone).toBe("Asia/Taipei");
  });

  it("rejects out-of-range numbers", () => {
    expect(() => parseSettings(JSON.stringify({ overdue_days: -1 }))).toThrow();
    expect(() => parseSettings(JSON.stringify({ proof_retention_months: 0 }))).toThrow();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @chippo/worker test env`
Expected: FAIL ("parseSettings is not a function" / module export missing).

- [ ] **Step 3: Extend `src/env.ts`**

Append to `packages/worker/src/env.ts`:

```ts
export interface WorkspaceSettings {
  timezone: string;
  discord_guild_id: string;
  discord_billing_channel_id: string;
  discord_payment_message_id: string;
  overdue_days: number;
  delete_discord_original_message: boolean;
  proof_retention_months: number;
}

export const DEFAULT_SETTINGS: WorkspaceSettings = {
  timezone: "Asia/Taipei",
  discord_guild_id: "",
  discord_billing_channel_id: "",
  discord_payment_message_id: "",
  overdue_days: 3,
  delete_discord_original_message: false,
  proof_retention_months: 24,
};

function intInRange(v: unknown, fallback: number, min: number, max: number): number {
  if (v === undefined) return fallback;
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
    throw new Error(`invalid settings number: ${String(v)}`);
  }
  return v;
}

export function parseSettings(json: string): WorkspaceSettings {
  const raw = JSON.parse(json) as Record<string, unknown>;
  return {
    timezone: typeof raw.timezone === "string" ? raw.timezone : DEFAULT_SETTINGS.timezone,
    discord_guild_id:
      typeof raw.discord_guild_id === "string" ? raw.discord_guild_id : "",
    discord_billing_channel_id:
      typeof raw.discord_billing_channel_id === "string" ? raw.discord_billing_channel_id : "",
    discord_payment_message_id:
      typeof raw.discord_payment_message_id === "string" ? raw.discord_payment_message_id : "",
    overdue_days: intInRange(raw.overdue_days, DEFAULT_SETTINGS.overdue_days, 0, 60),
    delete_discord_original_message:
      typeof raw.delete_discord_original_message === "boolean"
        ? raw.delete_discord_original_message
        : DEFAULT_SETTINGS.delete_discord_original_message,
    proof_retention_months: intInRange(
      raw.proof_retention_months, DEFAULT_SETTINGS.proof_retention_months, 1, 600
    ),
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @chippo/worker test env`
Expected: PASS (3 tests).

- [ ] **Step 5: Typecheck the whole package and run the full suite**

Run: `pnpm --filter @chippo/worker typecheck && pnpm --filter @chippo/worker test`
Expected: typecheck clean; all suites PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(env): typed workspace settings parsing with validation"
```

---

### Task 9: Remote D1 provisioning + README bootstrap (deploy gate)

> Requires owner credentials (roadmap §6). Do not guess IDs.

**Files:**
- Modify: `packages/worker/wrangler.toml` (real `database_id`)
- Create: `README.md`

- [ ] **Step 1: Ensure wrangler is authenticated**

Ask the owner to run **`! wrangler login`** in this session, or to provide
`CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`. Verify with
`wrangler whoami`.

- [ ] **Step 2: Create the remote D1 database**

Run: `wrangler d1 create chippo-db`
Copy the returned `database_id` into `packages/worker/wrangler.toml`.

- [ ] **Step 3: Create the R2 bucket (private)**

Run: `wrangler r2 bucket create chippo-proofs`
(R2 buckets are private by default — do not enable public access.)

- [ ] **Step 4: Apply migrations to remote D1**

Run: `wrangler d1 migrations apply chippo-db --remote`
Verify: `wrangler d1 execute chippo-db --remote --command "SELECT name, monthly_amount FROM plans"`
Expected: the three seeded plans.

- [ ] **Step 5: Write README bootstrap section**

Create `README.md` documenting: prerequisites (Node 22, pnpm), `pnpm install`,
`pnpm --filter @chippo/worker test`, local migrate
(`pnpm --filter @chippo/worker migrate:local`), and the remote provisioning commands
above. (Expanded into a full runbook in Phase 8.)

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: provision remote D1 + R2 and document bootstrap"
```

---

## Phase 1 Self-Review checklist

- [ ] **Spec coverage:** §4 conventions (time/tokens) ✓ Task 4-5; §5 all tables + indexes
  ✓ Task 2; seed §1.1/§5.3/§5.6 ✓ Task 3; §6 settings schema ✓ Task 8; audit_logs §5.9 ✓
  Task 7; §17.1-2 ✓ Tasks 1-8. (Payment/billing/storage logic is Phase 2 — out of scope.)
- [ ] **Placeholder scan:** no TODO/TBD; every code step shows complete code.
- [ ] **Type consistency:** `WorkspaceRow`/`PlanRow` (db.ts) reused; `nowUtcIso` used by
  audit.ts; `WorkspaceSettings`/`DEFAULT_SETTINGS` consistent across env.ts + tests.
- [ ] **Deviations** recorded in roadmap §4 (notification_logs sentinels, source CHECK).

## Done criteria for Phase 1

1. `pnpm --filter @chippo/worker test` — all suites green.
2. `pnpm --filter @chippo/worker typecheck` — clean.
3. `wrangler d1 migrations apply chippo-db --remote` — succeeds, seed verified.
4. Clean git history of small conventional commits.
