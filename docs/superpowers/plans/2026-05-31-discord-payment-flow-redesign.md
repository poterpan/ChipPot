# Discord-first 繳費流程改版 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move ChipPot payment operations entirely into Discord (persistent button → channel select → submit, no default web link), aggregate all of a user's period subscriptions into one settlement, and replace the auto "開繳" notice with a manually-triggered "發起繳費" that confirms amounts first.

**Architecture:** A new channel-agnostic core `settleUserPeriod` pays all of a user's active-subscription payments for a period in one atomic operation (Discord direct-update path; web token-gated batch path), sharing one screenshot key across rows. A new core `initiateBillingOpened` updates prices/amounts and posts the billing-opened notice through the existing `Notifier`, claiming the same `billing_opened` dedup slot the cron uses — so a manual trigger automatically suppresses the cron notice. Retention switches to reference-counting before deleting shared R2 objects. The Discord adapter gains a button→string-select flow, a channel param on `/繳費`, and a `/發起繳費` modal; the web page and admin SPA gain a channel selector and a 發起繳費 trigger.

**Tech Stack:** Cloudflare Workers + D1 (SQLite) + R2, TypeScript, Vitest 4.1 + `@cloudflare/vitest-pool-workers`, Discord interactions (Ed25519), Vite + React (web + admin SPAs).

**Source spec:** `docs/superpowers/specs/2026-05-31-discord-payment-flow-redesign-design.md`

---

## Decision: no price toggle (owner, 2026-05-31)

The spec floated a "同時更新方案定價" toggle (temporary-month vs permanent price). **The owner removed it:** because prices float, any change to a plan's amount is always the plan's new price. So `initiateBillingOpened` **always writes `plans.monthly_amount`** and always rewrites this period's pending payment amounts — no toggle, no `updatePlanPrices` parameter, no checkbox in Discord or the admin UI. (Paid/verified rows stay frozen regardless.)

---

## File Structure

**Worker — new files**
- `packages/worker/migrations/0004_declared_channel_drop_unique.sql` — add `payments.declared_channel_tag_id`, drop the screenshot_key unique index.
- `packages/worker/scripts/register-commands.mjs` — (re)register the guild slash commands (`/繳費`, `/發起繳費`).
- `packages/worker/test/core/settle.test.ts` — `settleUserPeriod` (multi-sub, proof sharing, token atomicity/compensation).
- `packages/worker/test/core/billing-initiate.test.ts` — `initiateBillingOpened` (prices, pending amounts, notify, cron dedup).
- `packages/worker/test/core/retention.test.ts` — reference-counting retention.
- `packages/worker/test/adapters/discord-pay.test.ts` — button→select + multi-sub `/繳費` + channel.
- `packages/worker/test/adapters/discord-initiate.test.ts` — `/發起繳費` admin gate + modal + modal-submit.

**Worker — modified files**
- `src/env.ts` — `WorkspaceSettings.admin_discord_ids: string[]` + parse.
- `src/core/payments.ts` — add `declared_channel_tag_id` to `PaymentRow`.
- `src/core/db.ts` — `listActiveChannelTags`, `listSettleablePayments`.
- `src/core/storage.ts` — add `settleUserPeriod`; remove `submitProofWithToken`/`recordProof`/`recordDeclaredWithToken` (superseded).
- `src/core/billing.ts` — add `initiateBillingOpened`.
- `src/core/retention.ts` — reference-counting delete.
- `src/adapters/discord/commands.ts` — new constants, components, command defs.
- `src/adapters/discord/handler.ts` — button→select, `/繳費` rewrite, `/發起繳費` + modal submit.
- `src/routes/upload.ts` — settle-based, channel param, at-least-one.
- `src/routes/admin.ts` — `POST /admin/billing/initiate`, verify pre-fills declared channel, payments list adds declared channel.
- `src/core/storage.test.ts` (delete), `test/core/payments.test.ts` (unchanged — `markPaid` kept as the state-machine primitive).

**Frontend — modified files**
- `packages/web/src/api.ts`, `packages/web/src/App.tsx` — channel selector, settle-all, at-least-one.
- `packages/admin/src/api.ts` — `initiateBilling`, `Payment.declared_*`.
- `packages/admin/src/views/Settings.tsx` — `admin_discord_ids` field + 發起繳費 modal.
- `packages/admin/src/views/Payments.tsx` — show declared channel; verify select defaults to declared.

---

# PHASE 1 — Schema & settings foundation

### Task 1: Migration 0004 — declared channel column + drop unique index

**Files:**
- Create: `packages/worker/migrations/0004_declared_channel_drop_unique.sql`
- Test: `packages/worker/test/schema.test.ts` (add a case)

- [ ] **Step 1: Write the migration**

```sql
-- Discord-first redesign: a user's per-period payments can share ONE screenshot (one
-- settlement covers all their subscriptions), so screenshot_key is no longer unique.
-- Add the user-declared channel (declared at submit; verified channel is set on review).

ALTER TABLE payments ADD COLUMN declared_channel_tag_id INTEGER REFERENCES channel_tags(id);

-- Multiple payments may now legitimately point at the same screenshot_key.
DROP INDEX idx_payments_screenshot_key;
```

- [ ] **Step 2: Add a schema test asserting the new column + dropped index**

Append to `packages/worker/test/schema.test.ts` (inside the existing top-level `describe`; match the file's existing `env.DB.prepare(...).all()` style):

```ts
it("0004 adds declared_channel_tag_id and drops the screenshot_key unique index", async () => {
  const cols = await env.DB.prepare("PRAGMA table_info(payments)").all<{ name: string }>();
  expect(cols.results.map((c) => c.name)).toContain("declared_channel_tag_id");

  const idx = await env.DB.prepare("PRAGMA index_list(payments)").all<{ name: string }>();
  expect(idx.results.map((i) => i.name)).not.toContain("idx_payments_screenshot_key");
});
```

- [ ] **Step 3: Run the schema test (migrations auto-apply in the pool)**

Run: `cd packages/worker && pnpm test schema`
Expected: PASS. (The vitest pool applies all `migrations/*.sql` via `readD1Migrations`, so 0004 runs automatically.)

- [ ] **Step 4: Apply locally to the dev D1 so manual testing matches**

Run: `cd packages/worker && pnpm migrate:local`
Expected: wrangler reports `0004_declared_channel_drop_unique.sql` applied (1 migration).

- [ ] **Step 5: Commit**

```bash
git add packages/worker/migrations/0004_declared_channel_drop_unique.sql packages/worker/test/schema.test.ts
git commit -m "feat(db): migration 0004 — declared_channel_tag_id + drop screenshot_key unique index"
```

---

### Task 2: `settings.admin_discord_ids`

**Files:**
- Modify: `packages/worker/src/env.ts`
- Test: `packages/worker/test/env.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/worker/test/env.test.ts` (match the existing `parseSettings` test style):

```ts
it("parses admin_discord_ids as a string array, defaulting to []", () => {
  expect(parseSettings("{}").admin_discord_ids).toEqual([]);
  expect(parseSettings(JSON.stringify({ admin_discord_ids: ["123", "456"] })).admin_discord_ids)
    .toEqual(["123", "456"]);
  // non-string members are dropped; non-arrays fall back to []
  expect(parseSettings(JSON.stringify({ admin_discord_ids: ["123", 7, null] })).admin_discord_ids)
    .toEqual(["123"]);
  expect(parseSettings(JSON.stringify({ admin_discord_ids: "nope" })).admin_discord_ids).toEqual([]);
});
```

- [ ] **Step 2: Run it to verify failure**

Run: `cd packages/worker && pnpm test env`
Expected: FAIL — `admin_discord_ids` is `undefined`.

- [ ] **Step 3: Implement in `src/env.ts`**

Add to the `WorkspaceSettings` interface (after `proof_retention_months`):

```ts
  admin_discord_ids: string[];
```

Add to `DEFAULT_SETTINGS` (after `proof_retention_months: 24,`):

```ts
  admin_discord_ids: [],
```

Add this helper next to `str`:

```ts
function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}
```

Add to the object returned by `parseSettings` (after the `proof_retention_months` line):

```ts
    admin_discord_ids: strArray(raw.admin_discord_ids),
```

- [ ] **Step 4: Run it to verify pass**

Run: `cd packages/worker && pnpm test env`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/worker/src/env.ts packages/worker/test/env.test.ts
git commit -m "feat(settings): admin_discord_ids whitelist (parse + default [])"
```

---

### Task 3: `PaymentRow.declared_channel_tag_id`

**Files:**
- Modify: `packages/worker/src/core/payments.ts:5-28`

- [ ] **Step 1: Add the field to the row type**

In `PaymentRow`, immediately after `verified_channel_tag_id: number | null;` add:

```ts
  declared_channel_tag_id: number | null;
```

(No test needed — it's a type widening over `SELECT *`. `pnpm typecheck` is the gate.)

- [ ] **Step 2: Typecheck**

Run: `cd packages/worker && pnpm typecheck`
Expected: PASS (no errors).

- [ ] **Step 3: Commit**

```bash
git add packages/worker/src/core/payments.ts
git commit -m "feat(payments): add declared_channel_tag_id to PaymentRow"
```

---

### ✅ Phase 1 checkpoint — Codex review

- [ ] **Run the full worker suite:** `cd packages/worker && pnpm test` — expect all green.
- [ ] **Codex review** (foreground): invoke the `codex:codex-rescue` subagent with:
  > Review ChipPot redesign Phase 1: migration `0004_declared_channel_drop_unique.sql` (SQLite ALTER ADD COLUMN with REFERENCES + DROP INDEX correctness), `parseSettings` admin_discord_ids handling, and PaymentRow widening. Files: packages/worker/migrations/0004_declared_channel_drop_unique.sql, packages/worker/src/env.ts, packages/worker/src/core/payments.ts. Flag any schema/parse bug.
- [ ] Address findings (one at a time, test each), then continue.

---

# PHASE 2 — Core domain

### Task 4: `listActiveChannelTags` + `listSettleablePayments` (core/db.ts)

**Files:**
- Modify: `packages/worker/src/core/db.ts`
- Test: `packages/worker/test/core/db.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `packages/worker/test/core/db.test.ts`. Use a fresh id-space `9020` (per-file isolation; check the file's existing `beforeAll` and add these rows to it, or add a second `beforeAll` block with new ids). Add rows: workspace 9020, user 9020, plan 9020 (amount 315), two subscriptions 9020 & 90201, two channel_tags (one active, one inactive), and two pending payments for period `2027-01`.

```ts
import { listActiveChannelTags, listSettleablePayments } from "../../src/core/db";
// ... in beforeAll, after existing seeds:
// channel_tags: 9020 active "LINE Pay", 90201 inactive "停用"
// payments: pending for SUB 9020 (amount 315) and SUB 90201 (amount 251), period 2027-01

describe("channel tags + settleable payments", () => {
  it("listActiveChannelTags returns only active tags, sorted", async () => {
    const tags = await listActiveChannelTags(env.DB, 9020);
    expect(tags.map((t) => t.name)).toEqual(["LINE Pay"]);
  });

  it("listSettleablePayments returns pending/rejected payments for the user's active subs", async () => {
    const rows = await listSettleablePayments(env.DB, 9020, 9020, "2027-01");
    expect(rows.length).toBe(2);
    expect(rows.reduce((s, r) => s + r.amount, 0)).toBe(566);
    expect(rows[0]).toHaveProperty("plan_name");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/worker && pnpm test core/db`
Expected: FAIL — functions not exported.

- [ ] **Step 3: Implement in `src/core/db.ts`** (append at end)

```ts
export interface ChannelTagChoice {
  id: number;
  name: string;
}

/** Active channel tags for a workspace (payment channel picker), sorted for display. */
export async function listActiveChannelTags(
  db: D1Database,
  workspaceId: number
): Promise<ChannelTagChoice[]> {
  const { results } = await db
    .prepare(
      "SELECT id, name FROM channel_tags WHERE workspace_id = ? AND active = 1 ORDER BY sort_order, id"
    )
    .bind(workspaceId)
    .all<ChannelTagChoice>();
  return results;
}

export interface SettleablePayment {
  id: number;
  amount: number;
  plan_name: string;
}

/**
 * Payments that a single submit can still settle (pending/rejected) for a user's active
 * subscriptions in a period. Used to show the per-plan breakdown + total before settling.
 */
export async function listSettleablePayments(
  db: D1Database,
  workspaceId: number,
  userId: number,
  period: string
): Promise<SettleablePayment[]> {
  const { results } = await db
    .prepare(
      `SELECT p.id AS id, p.amount AS amount, pl.name AS plan_name
       FROM payments p
       JOIN subscriptions s ON s.id = p.subscription_id
       JOIN plans pl ON pl.id = s.plan_id
       WHERE p.workspace_id = ? AND p.period = ? AND p.status IN ('pending','rejected')
         AND s.user_id = ? AND s.status = 'active'
       ORDER BY p.id`
    )
    .bind(workspaceId, period, userId)
    .all<SettleablePayment>();
  return results;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd packages/worker && pnpm test core/db`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/worker/src/core/db.ts packages/worker/test/core/db.test.ts
git commit -m "feat(db): listActiveChannelTags + listSettleablePayments"
```

---

### Task 5: `settleUserPeriod` — Discord direct path (no token)

**Files:**
- Modify: `packages/worker/src/core/storage.ts`
- Test: `packages/worker/test/core/settle.test.ts` (create)

This is the core "pay all of a user's period subs at once" function. This task adds the no-token (Discord) path; Task 6 adds the token (web) path.

- [ ] **Step 1: Write the failing test** (`packages/worker/test/core/settle.test.ts`)

```ts
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { settleUserPeriod } from "../../src/core/storage";
import { getObject } from "../../src/core/storage";

const TS = "2026-05-01T00:00:00.000Z";
const WS = 9021;
const SUB_A = 9021, SUB_B = 90211;
const TAG = 9021;
const PERIOD = "2027-02";
const PREFIX = `${WS}/${PERIOD}/${WS}/`;

beforeAll(async () => {
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO workspaces (id,name,owner_id,channel_type,billing_day,settings,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(WS, "W", "o", "discord", 5, "{}", TS, TS),
    env.DB.prepare(`INSERT INTO users (id,workspace_id,display_name,created_at,updated_at) VALUES (?,?,?,?,?)`).bind(WS, WS, "U", TS, TS),
    env.DB.prepare(`INSERT INTO plans (id,workspace_id,name,provider,monthly_amount,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`).bind(WS, WS, "ChatGPT", "openai", 315, TS, TS),
    env.DB.prepare(`INSERT INTO plans (id,workspace_id,name,provider,monthly_amount,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`).bind(90211, WS, "Claude", "anthropic", 251, TS, TS),
    env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(SUB_A, WS, WS, WS, "2027-02-01", 5, TS, TS),
    env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(SUB_B, WS, WS, 90211, "2027-02-01", 5, TS, TS),
    env.DB.prepare(`INSERT INTO channel_tags (id,workspace_id,name,type,sort_order,created_at) VALUES (?,?,?,?,?,?)`).bind(TAG, WS, "LINE Pay", "linepay", 1, TS),
  ]);
});

describe("settleUserPeriod — Discord direct path", () => {
  it("settles all of a user's period subs at once, no proof, records declared channel", async () => {
    const r = await settleUserPeriod(env, {
      workspaceId: WS, userId: WS, period: PERIOD,
      declaredChannelTagId: TAG, source: "user_slash",
    });
    expect(r.paidCount).toBe(2);
    expect(r.totalAmount).toBe(566);
    expect(r.screenshotKey).toBeNull();

    const rows = await env.DB.prepare(
      "SELECT status, has_proof, declared_channel_tag_id, source FROM payments WHERE workspace_id=? AND period=?"
    ).bind(WS, PERIOD).all<{ status: string; has_proof: number; declared_channel_tag_id: number; source: string }>();
    expect(rows.results.every((p) => p.status === "paid")).toBe(true);
    expect(rows.results.every((p) => p.declared_channel_tag_id === TAG)).toBe(true);
    expect(rows.results.every((p) => p.source === "user_slash")).toBe(true);
  });

  it("is a no-op when everything is already paid (alreadyPaidCount reported)", async () => {
    const r = await settleUserPeriod(env, {
      workspaceId: WS, userId: WS, period: PERIOD, source: "user_slash",
    });
    expect(r.paidCount).toBe(0);
    expect(r.alreadyPaidCount).toBe(2);
  });

  it("shares ONE screenshot key across all settled rows", async () => {
    const r = await settleUserPeriod(env, {
      workspaceId: WS, userId: WS, period: "2027-03", source: "user_slash",
      proof: { body: new Uint8Array([1, 2, 3]), ext: "png", contentType: "image/png" },
    });
    expect(r.paidCount).toBe(2);
    expect(r.screenshotKey).toMatch(new RegExp(`^${WS}/2027-03/${WS}/[0-9a-f-]{36}\\.png$`));
    const rows = await env.DB.prepare(
      "SELECT screenshot_key, has_proof FROM payments WHERE workspace_id=? AND period='2027-03'"
    ).bind(WS).all<{ screenshot_key: string; has_proof: number }>();
    expect(new Set(rows.results.map((x) => x.screenshot_key)).size).toBe(1);
    expect(rows.results.every((x) => x.has_proof === 1)).toBe(true);
    expect(await getObject(env.BUCKET, r.screenshotKey!)).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/worker && pnpm test core/settle`
Expected: FAIL — `settleUserPeriod` not exported.

- [ ] **Step 3: Implement the Discord path in `src/core/storage.ts`**

Add near the top type imports (already present): `buildScreenshotKey`, `putObject`, `deleteObject`, `R2Body`, `ensurePeriodPayment`, `nowUtcIso`, `TokenUnusable`, `NoEligiblePayment` exist. Append:

```ts
export interface SettleInput {
  workspaceId: number;
  userId: number;
  period: string;
  source: string; // "user_slash" (Discord) | "user_web" (web)
  declaredChannelTagId?: number | null;
  paymentNote?: string | null;
  proof?: { body: R2Body; ext: string; contentType: string } | null;
  tokenHash?: string | null; // web path only: atomically claim the one-time token
}

export interface SettleResult {
  paidCount: number;
  totalAmount: number;
  alreadyPaidCount: number;
  screenshotKey: string | null;
  paymentIds: number[];
}

/** pending/rejected payments for this user's active subs in the period (the settle targets). */
async function settleTargets(
  env: Env, workspaceId: number, userId: number, period: string
): Promise<{ id: number; amount: number }[]> {
  const { results } = await env.DB
    .prepare(
      `SELECT p.id AS id, p.amount AS amount FROM payments p
       JOIN subscriptions s ON s.id = p.subscription_id
       WHERE p.workspace_id = ? AND p.period = ? AND p.status IN ('pending','rejected')
         AND s.user_id = ? AND s.status = 'active'`
    )
    .bind(workspaceId, period, userId)
    .all<{ id: number; amount: number }>();
  return results;
}

async function alreadyPaidCount(
  env: Env, workspaceId: number, userId: number, period: string
): Promise<number> {
  const row = await env.DB
    .prepare(
      `SELECT COUNT(*) AS c FROM payments p
       JOIN subscriptions s ON s.id = p.subscription_id
       WHERE p.workspace_id = ? AND p.period = ? AND p.status IN ('paid','verified')
         AND s.user_id = ? AND s.status = 'active'`
    )
    .bind(workspaceId, period, userId)
    .first<{ c: number }>();
  return row?.c ?? 0;
}

/**
 * Settle ALL of a user's active-subscription payments for a period in one operation.
 * Discord paths (button/slash) take the direct path; the web path passes `tokenHash` to
 * additionally claim the one-time token atomically (see the token branch). A single
 * screenshot (if any) is stored once and its key shared across every settled row — the
 * screenshot_key UNIQUE index was dropped in migration 0004 to allow this.
 */
export async function settleUserPeriod(env: Env, input: SettleInput): Promise<SettleResult> {
  const { workspaceId, userId, period } = input;
  const now = nowUtcIso();

  // 1. Make sure every active sub has its period payment row (idempotent).
  const subs = await env.DB
    .prepare("SELECT id FROM subscriptions WHERE workspace_id = ? AND user_id = ? AND status = 'active'")
    .bind(workspaceId, userId)
    .all<{ id: number }>();
  for (const s of subs.results) await ensurePeriodPayment(env.DB, s.id, period);

  // 2. Which rows will this settle?
  const targets = await settleTargets(env, workspaceId, userId, period);
  if (targets.length === 0) {
    // Nothing to settle. Token path treats this as an error (no eligible payment); the
    // Discord path returns the already-paid count so the caller can message the user.
    if (input.tokenHash) throw new NoEligiblePayment(0, period);
    return {
      paidCount: 0, totalAmount: 0,
      alreadyPaidCount: await alreadyPaidCount(env, workspaceId, userId, period),
      screenshotKey: null, paymentIds: [],
    };
  }

  // 3. Store the proof once (shared key) if present.
  let key: string | null = null;
  if (input.proof) {
    key = buildScreenshotKey(workspaceId, period, userId, input.proof.ext, crypto.randomUUID());
    await putObject(env.BUCKET, key, input.proof.body, input.proof.contentType);
  }

  // 4. Apply. The web (token) path is a double-gated batch; the Discord path is a single
  //    multi-row UPDATE.
  try {
    if (input.tokenHash) {
      await applyTokenSettle(env, input, key, now);
    } else {
      await applyDirectSettle(env, input, key, now);
    }
  } catch (err) {
    if (key) await deleteObject(env.BUCKET, key).catch(() => {});
    throw err;
  }

  const paidRows = await env.DB
    .prepare(
      `SELECT p.id AS id, p.amount AS amount FROM payments p
       JOIN subscriptions s ON s.id = p.subscription_id
       WHERE p.workspace_id = ? AND p.period = ? AND p.status = 'paid' AND p.paid_at = ?
         AND s.user_id = ? AND s.status = 'active'`
    )
    .bind(workspaceId, period, now, userId)
    .all<{ id: number; amount: number }>();

  return {
    paidCount: paidRows.results.length,
    totalAmount: paidRows.results.reduce((s, r) => s + r.amount, 0),
    alreadyPaidCount: await alreadyPaidCount(env, workspaceId, userId, period),
    screenshotKey: key,
    paymentIds: paidRows.results.map((r) => r.id),
  };
}

/** Discord direct path: a single multi-row UPDATE across the user's settleable rows. */
async function applyDirectSettle(
  env: Env, input: SettleInput, key: string | null, now: string
): Promise<void> {
  const { workspaceId, userId, period } = input;
  await env.DB
    .prepare(
      `UPDATE payments
         SET status = 'paid', has_proof = ?, screenshot_key = ?, declared_channel_tag_id = ?,
             payment_note = COALESCE(?, payment_note), source = ?,
             submitted_at = ?, paid_at = ?, updated_at = ?
       WHERE workspace_id = ? AND period = ? AND status IN ('pending','rejected')
         AND subscription_id IN (
           SELECT id FROM subscriptions WHERE workspace_id = ? AND user_id = ? AND status = 'active')`
    )
    .bind(
      key ? 1 : 0, key, input.declaredChannelTagId ?? null,
      input.paymentNote ?? null, input.source, now, now, now,
      workspaceId, period, workspaceId, userId
    )
    .run();
}
```

Add the `applyTokenSettle` stub now so the file compiles; it gets its real body + tests in Task 6:

```ts
/** Web token path — implemented in Task 6. */
async function applyTokenSettle(
  _env: Env, _input: SettleInput, _key: string | null, _now: string
): Promise<void> {
  throw new Error("applyTokenSettle not implemented");
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd packages/worker && pnpm test core/settle`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/worker/src/core/storage.ts packages/worker/test/core/settle.test.ts
git commit -m "feat(core): settleUserPeriod Discord direct path (multi-sub, shared proof key)"
```

---

### Task 6: `settleUserPeriod` — web token path + retire old helpers

**Files:**
- Modify: `packages/worker/src/core/storage.ts`
- Modify: `packages/worker/test/core/settle.test.ts`
- Delete: `packages/worker/test/core/storage.test.ts` (its compensation coverage moves into settle.test.ts)

- [ ] **Step 1: Add token-path tests to `settle.test.ts`**

Seed two more unbound tokens in the `beforeAll` batch (period `2027-04`): `hashToken("settle-ok")` and `hashToken("settle-bad")` — both `workspace_id=WS, user_id=WS, subscription_id=NULL, expires_at=FUTURE`. Then add:

```ts
import { hashToken } from "../../src/core/tokens";
import { TokenUnusable, NoEligiblePayment } from "../../src/core/storage";

describe("settleUserPeriod — web token path", () => {
  it("claims the token once and settles all subs for the period", async () => {
    const r = await settleUserPeriod(env, {
      workspaceId: WS, userId: WS, period: "2027-04", source: "user_web",
      declaredChannelTagId: TAG, tokenHash: await hashToken("settle-ok"),
      proof: { body: new Uint8Array([9]), ext: "png", contentType: "image/png" },
    });
    expect(r.paidCount).toBe(2);
    const tok = await env.DB.prepare("SELECT used_at FROM upload_tokens WHERE token_hash=?")
      .bind(await hashToken("settle-ok")).first<{ used_at: string | null }>();
    expect(tok?.used_at).not.toBeNull();
  });

  it("rejects reuse of a spent token and leaves no orphan object", async () => {
    const before = (await env.BUCKET.list({ prefix: `${WS}/2027-04/${WS}/` })).objects.length;
    await expect(settleUserPeriod(env, {
      workspaceId: WS, userId: WS, period: "2027-04", source: "user_web",
      tokenHash: await hashToken("settle-ok"),
      proof: { body: new Uint8Array([9]), ext: "png", contentType: "image/png" },
    })).rejects.toBeInstanceOf(TokenUnusable);
    const after = (await env.BUCKET.list({ prefix: `${WS}/2027-04/${WS}/` })).objects.length;
    expect(after).toBe(before); // failed upload compensated
  });

  it("rejects when nothing is settleable (already paid) without consuming the token", async () => {
    await expect(settleUserPeriod(env, {
      workspaceId: WS, userId: WS, period: "2027-04", source: "user_web",
      tokenHash: await hashToken("settle-bad"),
    })).rejects.toBeInstanceOf(NoEligiblePayment);
    const tok = await env.DB.prepare("SELECT used_at FROM upload_tokens WHERE token_hash=?")
      .bind(await hashToken("settle-bad")).first<{ used_at: string | null }>();
    expect(tok?.used_at).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/worker && pnpm test core/settle`
Expected: FAIL — `applyTokenSettle not implemented`.

- [ ] **Step 3: Replace the `applyTokenSettle` stub** in `src/core/storage.ts`

```ts
/**
 * Web token path: a double-gated D1 batch. The payments UPDATE fires only while the token
 * is still unused; the token claim fires only once the payments carry our paid_at marker —
 * so both apply or neither, and the one-time token can't be spent twice. On an ambiguous
 * batch error we read back by the paid_at marker before deciding whether to compensate.
 */
async function applyTokenSettle(
  env: Env, input: SettleInput, key: string | null, now: string
): Promise<void> {
  const { workspaceId, userId, period } = input;
  const tokenHash = input.tokenHash!;

  const landed = () =>
    env.DB
      .prepare(
        `SELECT 1 AS ok FROM payments p JOIN subscriptions s ON s.id = p.subscription_id
         WHERE p.workspace_id = ? AND p.period = ? AND p.status = 'paid' AND p.paid_at = ?
           AND s.user_id = ? AND s.status = 'active' LIMIT 1`
      )
      .bind(workspaceId, period, now, userId)
      .first<{ ok: number }>()
      .catch(() => null);

  let payChanges = 0, tokChanges = 0;
  try {
    const results = await env.DB.batch([
      env.DB
        .prepare(
          `UPDATE payments
             SET status = 'paid', has_proof = ?, screenshot_key = ?, declared_channel_tag_id = ?,
                 payment_note = COALESCE(?, payment_note), source = ?,
                 submitted_at = ?, paid_at = ?, updated_at = ?
           WHERE workspace_id = ? AND period = ? AND status IN ('pending','rejected')
             AND subscription_id IN (
               SELECT id FROM subscriptions WHERE workspace_id = ? AND user_id = ? AND status = 'active')
             AND EXISTS (SELECT 1 FROM upload_tokens t
                         WHERE t.token_hash = ? AND t.user_id = ? AND t.period = ? AND t.workspace_id = ?
                           AND t.used_at IS NULL AND t.revoked_at IS NULL AND t.expires_at > ?)`
        )
        .bind(
          key ? 1 : 0, key, input.declaredChannelTagId ?? null,
          input.paymentNote ?? null, input.source, now, now, now,
          workspaceId, period, workspaceId, userId,
          tokenHash, userId, period, workspaceId, now
        ),
      env.DB
        .prepare(
          `UPDATE upload_tokens
             SET used_at = ?, used_by_source = ?
           WHERE token_hash = ? AND user_id = ? AND period = ? AND workspace_id = ?
             AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?
             AND EXISTS (SELECT 1 FROM payments p JOIN subscriptions s ON s.id = p.subscription_id
                         WHERE p.workspace_id = ? AND p.period = ? AND p.paid_at = ? AND p.status = 'paid'
                           AND s.user_id = ? AND s.status = 'active')`
        )
        .bind(
          now, input.source,
          tokenHash, userId, period, workspaceId, now,
          workspaceId, period, now, userId
        ),
    ]);
    payChanges = results[0]?.meta.changes ?? 0;
    tokChanges = results[1]?.meta.changes ?? 0;
  } catch (err) {
    if (await landed()) return; // committed despite the error; keep the object
    throw err;
  }

  if (payChanges >= 1 && tokChanges === 1) return; // success

  // Nothing applied — decide the precise error (caller compensates the R2 object).
  const tok = await env.DB
    .prepare(
      `SELECT 1 AS ok FROM upload_tokens
       WHERE token_hash = ? AND user_id = ? AND period = ? AND workspace_id = ?
         AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?`
    )
    .bind(tokenHash, userId, period, workspaceId, now)
    .first<{ ok: number }>();
  if (!tok) throw new TokenUnusable(tokenHash);
  throw new NoEligiblePayment(0, period);
}
```

- [ ] **Step 4: Remove the now-superseded helpers** from `src/core/storage.ts`

Delete `submitProofWithToken` + `SubmitProofInput` + `SubmitProofResult`, `recordProof` + `RecordProofInput`, `recordDeclaredWithToken` + `DeclareInput`, and the standalone `throwSubmitError` (its logic now lives inline in `applyTokenSettle`). Keep `TokenUnusable`, `NoEligiblePayment`, `buildScreenshotKey`, the image guards, and the R2 primitives (`putObject`/`getObject`/`deleteObject`/`R2Body`).

- [ ] **Step 5: Delete the obsolete storage test**

```bash
git rm packages/worker/test/core/storage.test.ts
```

(Its helper-level coverage — image guards, key format, R2 round-trip — is incidental; key format + sharing is covered in settle.test.ts. If you want to keep the pure-helper tests, move the `buildScreenshotKey`/`extForContentType`/`assertImageOk`/`put-get-delete` `it` blocks into a new `test/core/storage-helpers.test.ts` first. Recommended: keep them.)

Recommended move (create `test/core/storage-helpers.test.ts`) — copy the first `describe("storage helpers", ...)` block verbatim from the old file, importing only `buildScreenshotKey, extForContentType, assertImageOk, InvalidImage, putObject, getObject, deleteObject`.

- [ ] **Step 6: Run the suite**

Run: `cd packages/worker && pnpm test core/settle core/storage-helpers && pnpm typecheck`
Expected: PASS; typecheck clean (no dangling references to the removed functions — those call sites get rewired in Phase 3/4, so expect `pnpm typecheck` to FAIL on `routes/upload.ts` and `adapters/discord/handler.ts` until then).

> NOTE: Because Task 6 removes functions still imported by `upload.ts`/`handler.ts`, the worker won't fully typecheck until Tasks 11–13 rewire them. That's expected mid-phase. The settle + storage-helpers *tests* pass in isolation. Do NOT "fix" the broken imports yet — they're handled in their own tasks.

- [ ] **Step 7: Commit**

```bash
git add packages/worker/src/core/storage.ts packages/worker/test/core/settle.test.ts packages/worker/test/core/storage-helpers.test.ts
git rm packages/worker/test/core/storage.test.ts
git commit -m "feat(core): settleUserPeriod web token path; retire single-payment helpers"
```

---

### Task 7: `initiateBillingOpened` (billing.ts)

**Files:**
- Modify: `packages/worker/src/core/billing.ts`
- Test: `packages/worker/test/core/billing-initiate.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```ts
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { initiateBillingOpened } from "../../src/core/billing";
import { claimNotification, type Notifier, type PlanOpenLine } from "../../src/core/notify";

const TS = "2026-05-01T00:00:00.000Z";
const WS = 9022;
const PLAN_A = 9022, PLAN_B = 90221;
const SUB_A = 9022, SUB_B = 90221;
const CHAN = "chan-9022";
const PERIOD = "2027-05";

const sent: { period: string; lines: PlanOpenLine[] }[] = [];
const notifier: Notifier = {
  async sendBillingOpened(_e, _ch, period, lines) { sent.push({ period, lines }); },
  async sendOverdue() {},
};

beforeAll(async () => {
  const settings = JSON.stringify({ discord_billing_channel_id: CHAN });
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO workspaces (id,name,owner_id,channel_type,billing_day,settings,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(WS, "W", "o", "discord", 5, settings, TS, TS),
    env.DB.prepare(`INSERT INTO users (id,workspace_id,display_name,created_at,updated_at) VALUES (?,?,?,?,?)`).bind(WS, WS, "U", TS, TS),
    env.DB.prepare(`INSERT INTO plans (id,workspace_id,name,provider,monthly_amount,discord_role_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(PLAN_A, WS, "ChatGPT", "openai", 315, "role-a", TS, TS),
    env.DB.prepare(`INSERT INTO plans (id,workspace_id,name,provider,monthly_amount,discord_role_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(PLAN_B, WS, "Claude", "anthropic", 251, "role-b", TS, TS),
    env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(SUB_A, WS, WS, PLAN_A, "2027-05-01", 5, TS, TS),
    env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(SUB_B, WS, WS, PLAN_B, "2027-05-01", 5, TS, TS),
    // an already-paid payment for SUB_A: its amount must NOT be touched by initiate.
    env.DB.prepare(`INSERT INTO payments (workspace_id,subscription_id,period,period_start,period_end,due_date,amount,status,paid_at,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).bind(WS, SUB_A, PERIOD, `${PERIOD}-01`, `${PERIOD}-31`, `${PERIOD}-05`, 315, "paid", TS, "user_slash", TS, TS),
  ]);
});

describe("initiateBillingOpened", () => {
  it("updates prices + pending amounts, freezes paid rows, notifies, claims the slot", async () => {
    const r = await initiateBillingOpened(
      env, WS, PERIOD,
      { amounts: [{ plan_id: PLAN_A, amount: 400 }, { plan_id: PLAN_B, amount: 300 }] },
      "owner@x", notifier
    );
    expect(r.sent).toBe(true);

    // plan prices updated
    const pa = await env.DB.prepare("SELECT monthly_amount FROM plans WHERE id=?").bind(PLAN_A).first<{ monthly_amount: number }>();
    expect(pa?.monthly_amount).toBe(400);

    // SUB_A's PAID payment is frozen at 315; SUB_B's pending payment becomes 300
    const paidRow = await env.DB.prepare("SELECT amount,status FROM payments WHERE subscription_id=? AND period=?").bind(SUB_A, PERIOD).first<{ amount: number; status: string }>();
    expect(paidRow).toMatchObject({ amount: 315, status: "paid" });
    const pendRow = await env.DB.prepare("SELECT amount,status FROM payments WHERE subscription_id=? AND period=?").bind(SUB_B, PERIOD).first<{ amount: number; status: string }>();
    expect(pendRow).toMatchObject({ amount: 300, status: "pending" });

    // notice tagged both plan roles
    expect(sent.at(-1)?.lines.map((l) => l.role_id).sort()).toEqual(["role-a", "role-b"]);
  });

  it("a manual initiate claims the billing_opened slot so cron would skip", async () => {
    // slot already claimed by the prior test -> claimNotification now returns false
    const won = await claimNotification(env.DB, { workspaceId: WS, type: "billing_opened", period: PERIOD });
    expect(won).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/worker && pnpm test core/billing-initiate`
Expected: FAIL — `initiateBillingOpened` not exported.

- [ ] **Step 3: Implement in `src/core/billing.ts`**

Add imports at the top:

```ts
import type { Env } from "../env";
import { parseSettings } from "../env";
import { writeAudit } from "./audit";
import { claimNotification, type Notifier, type PlanOpenLine } from "./notify";
```

Append:

```ts
export interface PlanAmount {
  plan_id: number;
  amount: number;
}

export interface InitiateInput {
  amounts: PlanAmount[];
}

export interface InitiateResult {
  sent: boolean;
  updatedPlans: number;
  updatedPayments: number;
}

/**
 * Manually "發起繳費" for a period: write the confirmed amounts back as the plans' new prices
 * (any change is always the new price — owner decision, no temporary-month mode), rewrite this
 * period's still-PENDING payment amounts (paid/verified are frozen), then post the
 * billing-opened notice — claiming the same dedup slot the cron uses, so a manual trigger and
 * the cron can never both notify.
 */
export async function initiateBillingOpened(
  env: Env,
  workspaceId: number,
  period: string,
  input: InitiateInput,
  actor: string,
  notifier: Notifier
): Promise<InitiateResult> {
  const now = nowUtcIso();
  const plans = await env.DB
    .prepare("SELECT id, name, monthly_amount, discord_role_id, active FROM plans WHERE workspace_id = ?")
    .bind(workspaceId)
    .all<{ id: number; name: string; monthly_amount: number; discord_role_id: string | null; active: number }>();
  const planById = new Map(plans.results.map((p) => [p.id, p]));
  const amountByPlan = new Map<number, number>();

  let updatedPlans = 0;
  let updatedPayments = 0;

  for (const a of input.amounts) {
    const plan = planById.get(a.plan_id);
    if (!plan) continue; // ignore amounts for plans outside this workspace
    if (!Number.isInteger(a.amount) || a.amount < 0) continue;
    amountByPlan.set(a.plan_id, a.amount);

    if (a.amount !== plan.monthly_amount) {
      await env.DB.prepare("UPDATE plans SET monthly_amount = ?, updated_at = ? WHERE id = ?")
        .bind(a.amount, now, a.plan_id).run();
      await writeAudit(env.DB, {
        workspaceId, actor, action: "amount.override", entityType: "plan", entityId: a.plan_id,
        before: { monthly_amount: plan.monthly_amount }, after: { monthly_amount: a.amount },
      });
      updatedPlans++;
    }
  }

  // Ensure this period's payments exist for every active sub, then rewrite PENDING amounts.
  const subs = await env.DB
    .prepare("SELECT id, plan_id FROM subscriptions WHERE workspace_id = ? AND status = 'active'")
    .bind(workspaceId)
    .all<{ id: number; plan_id: number }>();
  for (const s of subs.results) await ensurePeriodPayment(env.DB, s.id, period);
  for (const [planId, amount] of amountByPlan) {
    const res = await env.DB
      .prepare(
        `UPDATE payments SET amount = ?, updated_at = ?
         WHERE workspace_id = ? AND period = ? AND status = 'pending'
           AND subscription_id IN (SELECT id FROM subscriptions WHERE workspace_id = ? AND plan_id = ? AND status = 'active')`
      )
      .bind(amount, now, workspaceId, period, workspaceId, planId)
      .run();
    updatedPayments += res.meta.changes ?? 0;
  }

  // Notify (claim the shared billing_opened slot — cron uses the same key).
  const ws = await env.DB.prepare("SELECT settings FROM workspaces WHERE id = ?").bind(workspaceId).first<{ settings: string }>();
  const channelId = parseSettings(ws!.settings).discord_billing_channel_id;
  let sent = false;
  if (channelId && env.DISCORD_BOT_TOKEN) {
    if (await claimNotification(env.DB, { workspaceId, type: "billing_opened", period })) {
      const lines: PlanOpenLine[] = subs.results
        .map((s) => planById.get(s.plan_id))
        .filter((p): p is NonNullable<typeof p> => !!p && p.active === 1)
        .filter((p, i, arr) => arr.findIndex((q) => q.id === p.id) === i) // dedupe plans
        .map((p) => ({
          plan_id: p.id, plan_name: p.name, role_id: p.discord_role_id,
          amount: amountByPlan.get(p.id) ?? p.monthly_amount,
        }));
      if (lines.length > 0) {
        await notifier.sendBillingOpened(env, channelId, period, lines);
        sent = true;
      }
    }
  }

  await writeAudit(env.DB, {
    workspaceId, actor, action: "billing.initiate", entityType: "workspace", entityId: workspaceId,
    after: { period, updatedPlans, updatedPayments, sent },
  });

  return { sent, updatedPlans, updatedPayments };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd packages/worker && pnpm test core/billing-initiate`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/worker/src/core/billing.ts packages/worker/test/core/billing-initiate.test.ts
git commit -m "feat(core): initiateBillingOpened — confirm amounts, freeze paid, notify, dedup"
```

---

### Task 8: Retention reference-counting

**Files:**
- Modify: `packages/worker/src/core/retention.ts:39-58`
- Test: `packages/worker/test/core/retention.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```ts
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { runRetention } from "../../src/core/retention";
import { getObject, putObject } from "../../src/core/storage";

const TS = "2026-05-01T00:00:00.000Z";
const WS = 9023;
const SUB = 9023;
const NOW = new Date("2026-05-01T00:00:00.000Z"); // retention cutoff = 24mo before
const OLD = "2023-01-01T00:00:00.000Z"; // > 24mo before NOW -> eligible
const SHARED = "shared-key-9023";
const SOLO = "solo-key-9023";

beforeAll(async () => {
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO workspaces (id,name,owner_id,channel_type,billing_day,settings,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(WS, "W", "o", "discord", 5, "{}", TS, TS),
    env.DB.prepare(`INSERT INTO users (id,workspace_id,display_name,created_at,updated_at) VALUES (?,?,?,?,?)`).bind(WS, WS, "U", TS, TS),
    env.DB.prepare(`INSERT INTO plans (id,workspace_id,name,provider,monthly_amount,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`).bind(WS, WS, "P", "openai", 315, TS, TS),
    env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(SUB, WS, WS, WS, "2023-01-01", 5, TS, TS),
    // Two OLD payments sharing SHARED key (both eligible) + one OLD with SOLO key.
    env.DB.prepare(`INSERT INTO payments (workspace_id,subscription_id,period,period_start,period_end,due_date,amount,status,has_proof,screenshot_key,paid_at,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(WS, SUB, "2023-01", "2023-01-01", "2023-01-31", "2023-01-05", 315, "verified", 1, SHARED, OLD, "user_web", TS, TS),
    env.DB.prepare(`INSERT INTO payments (workspace_id,subscription_id,period,period_start,period_end,due_date,amount,status,has_proof,screenshot_key,paid_at,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(WS, SUB, "2023-02", "2023-02-01", "2023-02-28", "2023-02-05", 315, "verified", 1, SHARED, OLD, "user_web", TS, TS),
    env.DB.prepare(`INSERT INTO payments (workspace_id,subscription_id,period,period_start,period_end,due_date,amount,status,has_proof,screenshot_key,paid_at,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(WS, SUB, "2023-03", "2023-03-01", "2023-03-31", "2023-03-05", 315, "verified", 1, SOLO, OLD, "user_web", TS, TS),
  ]);
  await putObject(env.BUCKET, SHARED, new Uint8Array([1]), "image/png");
  await putObject(env.BUCKET, SOLO, new Uint8Array([2]), "image/png");
});

describe("runRetention reference-counting", () => {
  it("deletes the R2 object only after the LAST referencing payment is cleared", async () => {
    const cleared = await runRetention(env, WS, 24, NOW);
    expect(cleared).toBe(3); // all three D1 rows cleared

    // both shared rows nulled
    const shared = await env.DB.prepare("SELECT screenshot_key FROM payments WHERE screenshot_key=?").bind(SHARED).all();
    expect(shared.results.length).toBe(0);
    // object gone exactly once (ref count reached 0)
    expect(await getObject(env.BUCKET, SHARED)).toBeNull();
    expect(await getObject(env.BUCKET, SOLO)).toBeNull();
  });
});
```

Add a second test verifying a still-referenced object survives:

```ts
it("keeps the R2 object when a non-expired payment still references the key", async () => {
  const KEY = "mixed-key-9023";
  const RECENT = "2026-04-15T00:00:00.000Z"; // within 24mo of NOW -> NOT eligible
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO payments (workspace_id,subscription_id,period,period_start,period_end,due_date,amount,status,has_proof,screenshot_key,paid_at,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(WS, SUB, "2023-04", "2023-04-01", "2023-04-30", "2023-04-05", 315, "verified", 1, "mixed-key-9023", OLD, "user_web", TS, TS),
    env.DB.prepare(`INSERT INTO payments (workspace_id,subscription_id,period,period_start,period_end,due_date,amount,status,has_proof,screenshot_key,paid_at,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(WS, SUB, "2026-04", "2026-04-01", "2026-04-30", "2026-04-05", 315, "verified", 1, "mixed-key-9023", RECENT, "user_web", TS, TS),
  ]);
  await putObject(env.BUCKET, KEY, new Uint8Array([3]), "image/png");

  const cleared = await runRetention(env, WS, 24, NOW);
  expect(cleared).toBe(1); // only the OLD 2023-04 row cleared
  expect(await getObject(env.BUCKET, KEY)).not.toBeNull(); // still referenced by 2026-04
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/worker && pnpm test core/retention`
Expected: FAIL — current code deletes the R2 object on the first row, so the shared/mixed assertions fail.

- [ ] **Step 3: Rewrite the loop in `src/core/retention.ts`** (replace lines 39-58)

```ts
  let deleted = 0;
  for (const row of results) {
    try {
      // 1. Drop THIS payment's reference first (D1-first so this row never re-appears).
      await env.DB
        .prepare("UPDATE payments SET screenshot_key = NULL, proof_deleted_at = ?, updated_at = ? WHERE id = ?")
        .bind(taipeiDate(now), nowUtcIso(), row.id)
        .run();
      // 2. Only delete the R2 object when no OTHER payment still references the key.
      const ref = await env.DB
        .prepare("SELECT COUNT(*) AS c FROM payments WHERE screenshot_key = ?")
        .bind(row.screenshot_key)
        .first<{ c: number }>();
      if ((ref?.c ?? 0) === 0) {
        await env.BUCKET.delete(row.screenshot_key);
      }
      await writeAudit(env.DB, {
        workspaceId, actor: "system", action: "proof.auto_delete",
        entityType: "payment", entityId: row.id, before: { screenshot_key: row.screenshot_key },
      });
      deleted++;
    } catch (e) {
      console.error("retention failed for payment", row.id, e);
    }
  }
  return deleted;
```

Update the function's doc comment to describe reference-counting (replace the "R2-first" note).

- [ ] **Step 4: Run to verify pass + confirm the existing scheduled test still passes**

Run: `cd packages/worker && pnpm test core/retention core/scheduled`
Expected: PASS — retention.test green; scheduled.test (single-reference key) still deletes the object and reports `proofsDeleted: 1`.

- [ ] **Step 5: Commit**

```bash
git add packages/worker/src/core/retention.ts packages/worker/test/core/retention.test.ts
git commit -m "fix(retention): reference-count shared screenshot keys before R2 delete"
```

---

### ✅ Phase 2 checkpoint — Codex review

- [ ] **Run:** `cd packages/worker && pnpm test core` — all core tests green (typecheck still red on un-rewired routes; that's expected).
- [ ] **Codex review** (foreground), forwarding:
  > Review ChipPot redesign Phase 2 core domain for correctness, concurrency, and atomicity. Files: packages/worker/src/core/storage.ts (settleUserPeriod — both the Discord direct multi-row UPDATE and the web token double-gated batch; verify the one-time token cannot be double-spent, the shared screenshot key is correct, and R2 compensation/read-back is sound for the multi-row case), packages/worker/src/core/billing.ts (initiateBillingOpened — verify paid/verified amounts are frozen, pending amounts rewritten, billing_opened dedup slot claimed so cron can't double-notify), packages/worker/src/core/retention.ts (reference-counting — verify an R2 object is deleted only when its last D1 reference is cleared, and never while a non-expired row still points at it). Flag any race, double-spend, dangling-reference, or SQL bug.
- [ ] Address findings one at a time (test each). **Surface the modal-toggle deviation to the user here** before starting Phase 3.

---

# PHASE 3 — Discord adapter

### Task 9: Discord constants, components, command defs (commands.ts)

**Files:**
- Modify: `packages/worker/src/adapters/discord/commands.ts`

- [ ] **Step 1: Replace the file contents** of `src/adapters/discord/commands.ts`

```ts
// The persistent payment button's custom_id (action:workspace:version).
export const PAY_BUTTON_PREFIX = "chippot:pay";
// The channel string-select shown after the button (action:workspace:period).
export const PAY_SELECT_PREFIX = "chippot:paysel";
// The 發起繳費 modal (action:workspace:period). Text inputs use custom_id `amt:<plan_id>`.
export const INITIATE_MODAL_PREFIX = "chippot:initiate";

// Discord option types we use.
export const OPT_STRING = 3;
export const OPT_ATTACHMENT = 11;

// Interaction types.
export const IT_PING = 1;
export const IT_COMMAND = 2;
export const IT_COMPONENT = 3;
export const IT_AUTOCOMPLETE = 4;
export const IT_MODAL_SUBMIT = 5;

// Interaction response types.
export const RT_PONG = 1;
export const RT_MESSAGE = 4;
export const RT_DEFERRED = 5;
export const RT_UPDATE_MESSAGE = 7; // edit the component's source (ephemeral) message
export const RT_AUTOCOMPLETE = 8;
export const RT_MODAL = 9;

// Component types.
export const CT_ACTION_ROW = 1;
export const CT_BUTTON = 2;
export const CT_STRING_SELECT = 3;
export const CT_TEXT_INPUT = 4;

export const FLAG_EPHEMERAL = 64;

// MANAGE_GUILD bit (UI filter only; real authorization is the admin_discord_ids whitelist).
export const MANAGE_GUILD = "32";

/** The persistent payment message's button action row. custom_id = action:workspace:version. */
export function payButtonRow(workspaceId = 1, version = "v1") {
  return {
    type: CT_ACTION_ROW,
    components: [{ type: CT_BUTTON, style: 1, label: "繳費", custom_id: `${PAY_BUTTON_PREFIX}:${workspaceId}:${version}` }],
  };
}

/** String-select of active channel tags, shown after the button. */
export function channelSelectRow(
  workspaceId: number,
  period: string,
  tags: { id: number; name: string }[]
) {
  return {
    type: CT_ACTION_ROW,
    components: [{
      type: CT_STRING_SELECT,
      custom_id: `${PAY_SELECT_PREFIX}:${workspaceId}:${period}`,
      placeholder: "選擇繳費渠道",
      min_values: 1,
      max_values: 1,
      options: tags.slice(0, 25).map((t) => ({ label: t.name, value: String(t.id) })),
    }],
  };
}

/** Modal for 發起繳費: one text input per active plan, pre-filled with its current price. */
export function initiateModal(
  workspaceId: number,
  period: string,
  plans: { id: number; name: string; monthly_amount: number }[]
) {
  return {
    type: RT_MODAL,
    data: {
      custom_id: `${INITIATE_MODAL_PREFIX}:${workspaceId}:${period}`,
      title: `發起繳費 ${period}`,
      components: plans.slice(0, 5).map((p) => ({
        type: CT_ACTION_ROW,
        components: [{
          type: CT_TEXT_INPUT,
          custom_id: `amt:${p.id}`,
          label: `${p.name} 金額 (NT$)`,
          style: 1, // short
          value: String(p.monthly_amount),
          required: true,
          min_length: 1,
          max_length: 7,
        }],
      })),
    },
  };
}

/** `/繳費` command registration payload. */
export const PAY_COMMAND = {
  name: "繳費",
  type: 1,
  description: "登記本期繳費（一次涵蓋你所有訂閱，可選渠道／截圖／備註）",
  options: [
    { type: OPT_STRING, name: "渠道", description: "繳費渠道", autocomplete: true, required: false },
    { type: OPT_ATTACHMENT, name: "截圖", description: "繳費截圖（PNG / JPG / WebP）", required: false },
    { type: OPT_STRING, name: "備註", description: "備註（自由文字，僅供審核參考）", required: false },
  ],
};

/** `/發起繳費` command registration payload (admin-only; real auth = admin_discord_ids). */
export const INITIATE_COMMAND = {
  name: "發起繳費",
  type: 1,
  description: "（管理員）確認本期各方案金額並發出開繳通知",
  default_member_permissions: MANAGE_GUILD,
};
```

- [ ] **Step 2: Typecheck this module's consumers compile against the new exports**

Run: `cd packages/worker && pnpm typecheck`
Expected: still red on `handler.ts`/`upload.ts` (rewired later) but NO new errors referencing `commands.ts` exports beyond those files.

- [ ] **Step 3: Commit**

```bash
git add packages/worker/src/adapters/discord/commands.ts
git commit -m "feat(discord): channel-select + initiate-modal components, /發起繳費 command, /繳費 渠道 option"
```

---

### Task 10: Handler — button→channel-select + select-submit settle

**Files:**
- Modify: `packages/worker/src/adapters/discord/handler.ts`
- Test: `packages/worker/test/adapters/discord-pay.test.ts` (create)

- [ ] **Step 1: Write the failing test** (`discord-pay.test.ts`)

```ts
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { routeInteraction, type DiscordInteraction } from "../../src/adapters/discord/handler";

const TS = "2026-05-01T00:00:00.000Z";
const WS = 9024;
const GUILD = "guild-9024";
const DISC = "disc-9024";
const SUB_A = 9024, SUB_B = 90241;
const PLAN_B = 90241;
const TAG = 9024;

const tasks: Promise<unknown>[] = [];
const CTX = { waitUntil: (p: Promise<unknown>) => tasks.push(p) } as unknown as ExecutionContext;
const member = (id: string) => ({ member: { user: { id } } });

import { taipeiPeriod } from "../../src/core/time";
const PERIOD = taipeiPeriod();

beforeAll(async () => {
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO workspaces (id,name,owner_id,channel_type,billing_day,settings,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(WS, "W", "o", "discord", 5, JSON.stringify({ discord_guild_id: GUILD }), TS, TS),
    env.DB.prepare(`INSERT INTO users (id,workspace_id,discord_id,display_name,created_at,updated_at) VALUES (?,?,?,?,?,?)`).bind(WS, WS, DISC, "Member", TS, TS),
    env.DB.prepare(`INSERT INTO plans (id,workspace_id,name,provider,monthly_amount,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`).bind(WS, WS, "ChatGPT", "openai", 315, TS, TS),
    env.DB.prepare(`INSERT INTO plans (id,workspace_id,name,provider,monthly_amount,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`).bind(PLAN_B, WS, "Claude", "anthropic", 251, TS, TS),
    env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(SUB_A, WS, WS, WS, "2026-05-01", 5, TS, TS),
    env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(SUB_B, WS, WS, PLAN_B, "2026-05-01", 5, TS, TS),
    env.DB.prepare(`INSERT INTO channel_tags (id,workspace_id,name,type,sort_order,created_at) VALUES (?,?,?,?,?,?)`).bind(TAG, WS, "LINE Pay", "linepay", 1, TS),
  ]);
});

describe("button → channel select → settle", () => {
  it("button shows the per-plan total + a channel select", async () => {
    const i: DiscordInteraction = {
      type: 3, id: "1", token: "t", guild_id: GUILD, ...member(DISC),
      data: { custom_id: `chippot:pay:${WS}:v1`, component_type: 2 },
    };
    const res = await routeInteraction(i, env, CTX);
    const body = (await res.json()) as any;
    expect(body.type).toBe(4); // ephemeral message
    expect(body.data.content).toContain("566"); // 315 + 251
    const select = body.data.components[0].components[0];
    expect(select.type).toBe(3);
    expect(select.custom_id).toBe(`chippot:paysel:${WS}:${PERIOD}`);
    expect(select.min_values).toBe(1);
  });

  it("select submit settles all subs and confirms", async () => {
    const i: DiscordInteraction = {
      type: 3, id: "1", token: "t", guild_id: GUILD, ...member(DISC),
      data: { custom_id: `chippot:paysel:${WS}:${PERIOD}`, component_type: 3, values: [String(TAG)] },
    };
    const res = await routeInteraction(i, env, CTX);
    const body = (await res.json()) as any;
    expect(body.type).toBe(7); // UPDATE_MESSAGE
    expect(body.data.content).toContain("566");

    const rows = await env.DB.prepare("SELECT status, declared_channel_tag_id FROM payments WHERE workspace_id=? AND period=?").bind(WS, PERIOD).all<{ status: string; declared_channel_tag_id: number }>();
    expect(rows.results.length).toBe(2);
    expect(rows.results.every((p) => p.status === "paid")).toBe(true);
    expect(rows.results.every((p) => p.declared_channel_tag_id === TAG)).toBe(true);
  });

  it("button after paying says already registered", async () => {
    const i: DiscordInteraction = {
      type: 3, id: "1", token: "t", guild_id: GUILD, ...member(DISC),
      data: { custom_id: `chippot:pay:${WS}:v1`, component_type: 2 },
    };
    const res = await routeInteraction(i, env, CTX);
    const body = (await res.json()) as any;
    expect(body.data.content).toContain("已登記繳費");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/worker && pnpm test discord-pay`
Expected: FAIL — handler still issues a token link / doesn't branch by `component_type`.

- [ ] **Step 3: Rewrite `src/adapters/discord/handler.ts`** (button + select portions)

Replace the imports block + `DiscordInteraction` data type + `routeInteraction` + `handleButton`. New `DiscordInteraction.data` must include `component_type?: number; values?: string[]`. New top of file:

```ts
import type { Env } from "../../env";
import { json } from "../../http";
import { taipeiPeriod } from "../../core/time";
import { getWorkspaceIdByGuild, getUserByDiscordId, listActiveSubscriptions,
         listActiveChannelTags, listSettleablePayments } from "../../core/db";
import { settleUserPeriod, assertImageOk, extForContentType, InvalidImage } from "../../core/storage";
import { parseSettings } from "../../env";
import { initiateBillingOpened } from "../../core/billing";
import { discordNotifier } from "./notify";
import { editOriginalResponse } from "./api";
import {
  IT_COMMAND, IT_COMPONENT, IT_AUTOCOMPLETE, IT_MODAL_SUBMIT,
  RT_MESSAGE, RT_DEFERRED, RT_UPDATE_MESSAGE, RT_AUTOCOMPLETE, FLAG_EPHEMERAL,
  PAY_BUTTON_PREFIX, PAY_SELECT_PREFIX, INITIATE_MODAL_PREFIX,
  channelSelectRow, initiateModal,
} from "./commands";
```

Extend the interaction `data` type:

```ts
  data?: {
    name?: string;
    custom_id?: string;
    component_type?: number;
    values?: string[];
    options?: { name: string; value?: string; focused?: boolean }[];
    resolved?: { attachments?: Record<string, DiscordAttachment> };
    components?: { components: { custom_id: string; value: string }[] }[];
  };
```

`routeInteraction`:

```ts
export function routeInteraction(
  interaction: DiscordInteraction,
  env: Env,
  ctx: ExecutionContext
): Response | Promise<Response> {
  switch (interaction.type) {
    case IT_AUTOCOMPLETE: return handleAutocomplete(interaction, env);
    case IT_COMMAND: return handleCommand(interaction, env, ctx);
    case IT_COMPONENT: return handleComponent(interaction, env);
    case IT_MODAL_SUBMIT: return handleModalSubmit(interaction, env, ctx);
    default: return ephemeral("未支援的互動。");
  }
}

function handleComponent(i: DiscordInteraction, env: Env): Promise<Response> {
  const cid = i.data?.custom_id ?? "";
  if (cid.startsWith(PAY_SELECT_PREFIX)) return handlePaySelect(i, env);
  if (cid.startsWith(PAY_BUTTON_PREFIX)) return handlePayButton(i, env);
  return Promise.resolve(ephemeral("未支援的按鈕。"));
}
```

Replace `handleButton` with `handlePayButton` + `handlePaySelect`:

```ts
/** Shared member resolution. Returns the workspace + user, or an ephemeral error Response. */
async function resolveMember(
  i: DiscordInteraction, env: Env
): Promise<{ ws: number; userId: number } | Response> {
  if (!i.guild_id) return ephemeral("此互動需在伺服器內使用。");
  const ws = await getWorkspaceIdByGuild(env.DB, i.guild_id);
  if (!ws) return ephemeral("此伺服器尚未設定繳費系統。");
  const did = discordUserId(i);
  if (!did) return ephemeral("無法辨識你的 Discord 帳號。");
  const user = await getUserByDiscordId(env.DB, ws, did);
  if (!user) return ephemeral("你還不是登記的成員，請聯絡管理員新增。");
  return { ws, userId: user.id };
}

async function handlePayButton(i: DiscordInteraction, env: Env): Promise<Response> {
  const m = await resolveMember(i, env);
  if (m instanceof Response) return m;
  const { ws, userId } = m;

  const subs = await listActiveSubscriptions(env.DB, ws, userId);
  if (subs.length === 0) return ephemeral("你目前沒有有效訂閱。");

  const period = taipeiPeriod();
  // Ensure rows exist so settleable vs already-paid is accurate.
  const settleable = await ensureAndListSettleable(env, ws, userId, period, subs);
  if (settleable.length === 0) return ephemeral("✅ 你本期已登記繳費，無需重複操作。");

  const tags = await listActiveChannelTags(env.DB, ws);
  if (tags.length === 0) {
    return ephemeral("管理員尚未設定繳費渠道，請改用 `/繳費` 指令（可附截圖或備註）。");
  }
  const total = settleable.reduce((s, r) => s + r.amount, 0);
  const lines = settleable.map((r) => `・${r.plan_name}：NT$${r.amount.toLocaleString()}`).join("\n");
  return json({
    type: RT_MESSAGE,
    data: {
      flags: FLAG_EPHEMERAL,
      content: `本期（${period}）應繳：\n${lines}\n**合計 NT$${total.toLocaleString()}**\n\n請選擇繳費渠道送出。想附截圖／備註？改用 \`/繳費\`。`,
      components: [channelSelectRow(ws, period, tags)],
    },
  });
}

async function handlePaySelect(i: DiscordInteraction, env: Env): Promise<Response> {
  const m = await resolveMember(i, env);
  if (m instanceof Response) return m;
  const { ws, userId } = m;

  const parts = (i.data?.custom_id ?? "").split(":"); // chippot:paysel:<ws>:<period>
  const period = parts[3] ?? taipeiPeriod();
  const tagId = Number(i.data?.values?.[0]);
  if (!Number.isInteger(tagId)) return ephemeral("渠道無效，請重試。");

  try {
    const r = await settleUserPeriod(env, {
      workspaceId: ws, userId, period, declaredChannelTagId: tagId, source: "user_slash",
    });
    if (r.paidCount === 0) {
      return json({ type: RT_UPDATE_MESSAGE, data: { content: "✅ 你本期已登記繳費，無需重複操作。", components: [] } });
    }
    return json({
      type: RT_UPDATE_MESSAGE,
      data: { content: `✅ 已登記 NT$${r.totalAmount.toLocaleString()}（共 ${r.paidCount} 筆）。管理員確認收款後完成。`, components: [] },
    });
  } catch (err) {
    console.error("pay select failed", err);
    return json({ type: RT_UPDATE_MESSAGE, data: { content: "處理失敗，請稍後再試或改用 `/繳費`。", components: [] } });
  }
}

/** Ensure each active sub has its period payment, then return the settleable breakdown. */
async function ensureAndListSettleable(
  env: Env, ws: number, userId: number, period: string,
  subs: { id: number }[]
) {
  const { ensurePeriodPayment } = await import("../../core/billing");
  for (const s of subs) await ensurePeriodPayment(env.DB, s.id, period);
  return listSettleablePayments(env.DB, ws, userId, period);
}
```

> Replace the dynamic `import("../../core/billing")` with a static top-of-file import of `ensurePeriodPayment` from `../../core/billing` (cleaner). The dynamic form is shown only to keep this code block self-contained; prefer the static import.

- [ ] **Step 4: Run to verify pass**

Run: `cd packages/worker && pnpm test discord-pay`
Expected: PASS (3 tests). (The `/繳費` command + modal tests come next; this file's button/select tests pass now.)

- [ ] **Step 5: Commit**

```bash
git add packages/worker/src/adapters/discord/handler.ts packages/worker/test/adapters/discord-pay.test.ts
git commit -m "feat(discord): button → channel-select → settle-all flow"
```

---

### Task 11: Handler — `/繳費` rewrite (channel + at-least-one + settle-all) and autocomplete → channel tags

**Files:**
- Modify: `packages/worker/src/adapters/discord/handler.ts`
- Modify: `packages/worker/test/adapters/discord-handler.test.ts` (the old single-sub assertions change)

- [ ] **Step 1: Update `discord-handler.test.ts`** for the new `/繳費` semantics

Replace the autocomplete + `/繳費` cases. The autocomplete now returns **channel tags**, and `/繳費` settles all subs. Seed an active channel tag in this file's `beforeAll` (id `90091`, workspace `WS`). New cases:

```ts
it("autocomplete returns the workspace's active channel tags", async () => {
  const i: DiscordInteraction = {
    type: 4, id: "1", token: "t", guild_id: GUILD, ...member(DISC),
    data: { name: "繳費", options: [{ name: "渠道", focused: true, value: "" }] },
  };
  const res = await routeInteraction(i, env, CTX);
  const body = (await res.json()) as any;
  expect(body.type).toBe(8);
  expect(body.data.choices.some((c: any) => c.value === "90091")).toBe(true);
});

it("/繳費 with 渠道 settles every active sub for the period", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
  const i: DiscordInteraction = {
    type: 2, id: "1", token: "tok", guild_id: GUILD, ...member(DISC),
    data: { name: "繳費", options: [{ name: "渠道", value: "90091" }] },
  };
  const res = await routeInteraction(i, env, CTX);
  expect((await res.json() as any).type).toBe(5);
  await Promise.all(tasks.splice(0));
  vi.unstubAllGlobals();

  const p = await env.DB.prepare("SELECT status, declared_channel_tag_id, source FROM payments WHERE subscription_id = ? AND period = ?").bind(WS, PERIOD).first<{ status: string; declared_channel_tag_id: number; source: string }>();
  expect(p?.status).toBe("paid");
  expect(p?.declared_channel_tag_id).toBe(90091);
  expect(p?.source).toBe("user_slash");
});

it("/繳費 with nothing (no 渠道/截圖/備註) is rejected", async () => {
  const captured: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_u: unknown, init: RequestInit | undefined) => {
    if (typeof init?.body === "string") captured.push(JSON.parse(init.body).content);
    return new Response("{}", { status: 200 });
  }));
  const i: DiscordInteraction = {
    type: 2, id: "1", token: "tok2", guild_id: GUILD, ...member(DISC),
    data: { name: "繳費", options: [] },
  };
  await routeInteraction(i, env, CTX);
  await Promise.all(tasks.splice(0));
  vi.unstubAllGlobals();
  expect(captured.some((c) => c.includes("至少"))).toBe(true);
});
```

Add the channel tag to this file's `beforeAll` batch:

```ts
env.DB.prepare(`INSERT INTO channel_tags (id,workspace_id,name,type,sort_order,created_at) VALUES (?,?,?,?,?,?)`).bind(90091, WS, "LINE Pay", "linepay", 1, TS),
```

Delete the old "button issues a one-time upload link" + "rejects a non-member" button-link assertions (the button no longer issues links — covered by discord-pay.test.ts). Keep a non-member check against the button:

```ts
it("rejects a non-member on the button", async () => {
  const i: DiscordInteraction = {
    type: 3, id: "1", token: "t", guild_id: GUILD, ...member("stranger-999"),
    data: { custom_id: `chippot:pay:${WS}:v1`, component_type: 2 },
  };
  const res = await routeInteraction(i, env, CTX);
  expect((await res.json() as any).data.content).toContain("成員");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/worker && pnpm test discord-handler`
Expected: FAIL — autocomplete still returns subs; `/繳費` uses 方案.

- [ ] **Step 3: Rewrite `handleAutocomplete` + `computePayResult`** in `handler.ts`

```ts
async function handleAutocomplete(i: DiscordInteraction, env: Env): Promise<Response> {
  const choices: { name: string; value: string }[] = [];
  if (i.guild_id) {
    const ws = await getWorkspaceIdByGuild(env.DB, i.guild_id);
    if (ws) {
      const tags = await listActiveChannelTags(env.DB, ws);
      for (const t of tags.slice(0, 25)) choices.push({ name: t.name, value: String(t.id) });
    }
  }
  return json({ type: RT_AUTOCOMPLETE, data: { choices } });
}
```

Replace `computePayResult`:

```ts
async function computePayResult(i: DiscordInteraction, env: Env): Promise<string> {
  const m = await resolveMember(i, env);
  if (m instanceof Response) return (await m.json() as any).data.content;
  const { ws, userId } = m;

  const subs = await listActiveSubscriptions(env.DB, ws, userId);
  if (subs.length === 0) return "你目前沒有有效訂閱。";

  const period = taipeiPeriod();
  const note = getOption(i, "備註")?.value?.trim() || null;

  // Resolve declared channel (autocomplete value is a channel_tag id).
  let declaredChannelTagId: number | null = null;
  const chanOpt = getOption(i, "渠道")?.value;
  if (chanOpt) {
    const tagId = Number(chanOpt);
    const tags = await listActiveChannelTags(env.DB, ws);
    if (!tags.some((t) => t.id === tagId)) return "選擇的渠道無效，請重新選擇。";
    declaredChannelTagId = tagId;
  }

  // Optional screenshot.
  let proof: { body: ArrayBuffer; ext: string; contentType: string } | null = null;
  const attachOpt = getOption(i, "截圖");
  const attachment = attachOpt?.value ? i.data?.resolved?.attachments?.[attachOpt.value] : undefined;
  if (attachment) {
    const ct = attachment.content_type ?? "";
    try { assertImageOk(ct, attachment.size ?? 0); }
    catch (e) { if (e instanceof InvalidImage) return "截圖格式不支援或檔案過大，請改用備註或渠道。"; throw e; }
    if (!isDiscordCdnUrl(attachment.url)) return "截圖來源無效。";
    const res = await fetch(attachment.url);
    if (!res.ok) return "下載截圖失敗，請稍後再試。";
    const body = await res.arrayBuffer();
    try { assertImageOk(ct, body.byteLength); } catch { return "截圖檔案過大。"; }
    proof = { body, ext: extForContentType(ct), contentType: ct };
  }

  // At-least-one rule (slash): 渠道 / 截圖 / 備註.
  if (!declaredChannelTagId && !proof && !note) {
    return "請至少選擇「渠道」、附上「截圖」或填寫「備註」其中一項。";
  }

  const r = await settleUserPeriod(env, {
    workspaceId: ws, userId, period, source: "user_slash",
    declaredChannelTagId, paymentNote: note, proof,
  });
  if (r.paidCount === 0) return `本期（${period}）已登記繳費，無需重複操作。`;
  return `✅ 已登記本期（${period}）繳費 NT$${r.totalAmount.toLocaleString()}（共 ${r.paidCount} 筆）。管理員確認收款後完成。`;
}
```

Remove the now-unused imports (`markPaid`, `InvalidPaymentTransition`, `recordProof`, `NoEligiblePayment`, `issueUploadToken`, `ensurePeriodPayment` if only the button used it — keep `ensurePeriodPayment` since `ensureAndListSettleable` uses it). Keep `isDiscordCdnUrl`, `getOption`, `discordUserId`, `deferredReply`, `handleCommand` (extended next task).

- [ ] **Step 4: Run to verify pass**

Run: `cd packages/worker && pnpm test discord-handler discord-pay`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/worker/src/adapters/discord/handler.ts packages/worker/test/adapters/discord-handler.test.ts
git commit -m "feat(discord): /繳費 settles all subs with 渠道/截圖/備註 at-least-one; autocomplete=channels"
```

---

### Task 12: Handler — `/發起繳費` admin gate + modal + modal-submit

**Files:**
- Modify: `packages/worker/src/adapters/discord/handler.ts`
- Test: `packages/worker/test/adapters/discord-initiate.test.ts` (create)

- [ ] **Step 1: Write the failing test** (`discord-initiate.test.ts`)

```ts
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { routeInteraction, type DiscordInteraction } from "../../src/adapters/discord/handler";
import { taipeiPeriod } from "../../src/core/time";

const TS = "2026-05-01T00:00:00.000Z";
const WS = 9025;
const GUILD = "guild-9025";
const ADMIN = "admin-9025";
const NONADMIN = "rando-9025";
const PLAN = 9025;
const SUB = 9025;
const CHAN = "chan-9025";
const PERIOD = taipeiPeriod();

const tasks: Promise<unknown>[] = [];
const CTX = { waitUntil: (p: Promise<unknown>) => tasks.push(p) } as unknown as ExecutionContext;
const member = (id: string) => ({ member: { user: { id } } });

beforeAll(async () => {
  const settings = JSON.stringify({ discord_guild_id: GUILD, discord_billing_channel_id: CHAN, admin_discord_ids: [ADMIN] });
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO workspaces (id,name,owner_id,channel_type,billing_day,settings,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(WS, "W", "o", "discord", 5, settings, TS, TS),
    env.DB.prepare(`INSERT INTO users (id,workspace_id,discord_id,display_name,created_at,updated_at) VALUES (?,?,?,?,?,?)`).bind(WS, WS, ADMIN, "Admin", TS, TS),
    env.DB.prepare(`INSERT INTO plans (id,workspace_id,name,provider,monthly_amount,discord_role_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(PLAN, WS, "ChatGPT", "openai", 315, "role-x", TS, TS),
    env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(SUB, WS, WS, PLAN, "2026-05-01", 5, TS, TS),
  ]);
});

describe("/發起繳費", () => {
  it("opens a modal pre-filled with current prices for a whitelisted admin", async () => {
    const i: DiscordInteraction = {
      type: 2, id: "1", token: "t", guild_id: GUILD, ...member(ADMIN),
      data: { name: "發起繳費" },
    };
    const res = await routeInteraction(i, env, CTX);
    const body = (await res.json()) as any;
    expect(body.type).toBe(9); // MODAL
    expect(body.data.custom_id).toBe(`chippot:initiate:${WS}:${PERIOD}`);
    expect(body.data.components[0].components[0].value).toBe("315");
  });

  it("rejects a non-whitelisted member", async () => {
    const i: DiscordInteraction = {
      type: 2, id: "1", token: "t", guild_id: GUILD, ...member(NONADMIN),
      data: { name: "發起繳費" },
    };
    const res = await routeInteraction(i, env, CTX);
    const body = (await res.json()) as any;
    expect(body.type).toBe(4);
    expect(body.data.content).toContain("權限");
  });

  it("modal submit updates the price and posts the notice", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
    (env as any).DISCORD_BOT_TOKEN = "bot-token";
    const i: DiscordInteraction = {
      type: 5, id: "1", token: "tok", guild_id: GUILD, ...member(ADMIN),
      data: {
        custom_id: `chippot:initiate:${WS}:${PERIOD}`,
        components: [{ components: [{ custom_id: `amt:${PLAN}`, value: "500" }] }],
      },
    };
    const res = await routeInteraction(i, env, CTX);
    expect((await res.json() as any).type).toBe(5); // deferred ephemeral
    await Promise.all(tasks.splice(0));
    vi.unstubAllGlobals();

    const p = await env.DB.prepare("SELECT monthly_amount FROM plans WHERE id=?").bind(PLAN).first<{ monthly_amount: number }>();
    expect(p?.monthly_amount).toBe(500);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/worker && pnpm test discord-initiate`
Expected: FAIL — `發起繳費` not handled.

- [ ] **Step 3: Extend `handler.ts`**

In `handleCommand`, branch by command name (it currently hard-codes `繳費`):

```ts
function handleCommand(i: DiscordInteraction, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
  if (i.data?.name === "繳費") {
    ctx.waitUntil(deferredReply(i, env));
    return json({ type: RT_DEFERRED, data: { flags: FLAG_EPHEMERAL } });
  }
  if (i.data?.name === "發起繳費") return handleInitiateCommand(i, env);
  return ephemeral("未知指令。");
}
```

Add the admin gate + modal open + modal submit:

```ts
async function isAdmin(env: Env, ws: number, discordId: string | null): Promise<boolean> {
  if (!discordId) return false;
  const row = await env.DB.prepare("SELECT settings FROM workspaces WHERE id = ?").bind(ws).first<{ settings: string }>();
  if (!row) return false;
  return parseSettings(row.settings).admin_discord_ids.includes(discordId);
}

async function handleInitiateCommand(i: DiscordInteraction, env: Env): Promise<Response> {
  if (!i.guild_id) return ephemeral("此互動需在伺服器內使用。");
  const ws = await getWorkspaceIdByGuild(env.DB, i.guild_id);
  if (!ws) return ephemeral("此伺服器尚未設定繳費系統。");
  if (!(await isAdmin(env, ws, discordUserId(i)))) return ephemeral("你沒有發起繳費的權限。");

  const plans = await env.DB
    .prepare("SELECT id, name, monthly_amount FROM plans WHERE workspace_id = ? AND active = 1 ORDER BY id")
    .bind(ws)
    .all<{ id: number; name: string; monthly_amount: number }>();
  if (plans.results.length === 0) return ephemeral("沒有啟用中的方案。");

  const period = taipeiPeriod();
  return json(initiateModal(ws, period, plans.results.slice(0, 5)));
}

async function handleModalSubmit(i: DiscordInteraction, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (!i.data?.custom_id?.startsWith(INITIATE_MODAL_PREFIX)) return ephemeral("未支援的表單。");
  ctx.waitUntil(deferredInitiate(i, env));
  return json({ type: RT_DEFERRED, data: { flags: FLAG_EPHEMERAL } });
}

async function deferredInitiate(i: DiscordInteraction, env: Env): Promise<void> {
  let content: string;
  try {
    const parts = (i.data!.custom_id ?? "").split(":"); // chippot:initiate:<ws>:<period>
    const ws = Number(parts[2]);
    const period = parts[3]!;
    if (!(await isAdmin(env, ws, discordUserId(i)))) {
      content = "你沒有發起繳費的權限。";
    } else {
      const amounts: { plan_id: number; amount: number }[] = [];
      for (const row of i.data!.components ?? []) {
        for (const c of row.components) {
          if (c.custom_id.startsWith("amt:")) {
            const plan_id = Number(c.custom_id.slice(4));
            const amount = Number(String(c.value).trim());
            if (Number.isInteger(plan_id) && Number.isInteger(amount) && amount >= 0) {
              amounts.push({ plan_id, amount });
            }
          }
        }
      }
      const r = await initiateBillingOpened(env, ws, period, { amounts }, `discord:${discordUserId(i)}`, discordNotifier);
      content = r.sent
        ? `✅ 已發起 ${period} 繳費並發出通知（更新 ${r.updatedPlans} 個方案定價、${r.updatedPayments} 筆待繳金額）。`
        : `✅ 已更新本期金額（更新 ${r.updatedPlans} 個方案、${r.updatedPayments} 筆待繳）。本期通知先前已發送，未重複發送。`;
    }
  } catch (err) {
    console.error("initiate modal failed", err);
    content = "發起繳費失敗，請稍後再試。";
  }
  await editOriginalResponse(env.DISCORD_APPLICATION_ID ?? "", i.token, { content }).catch(() => {});
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd packages/worker && pnpm test discord-initiate && pnpm typecheck`
Expected: tests PASS; `pnpm typecheck` — handler.ts clean now; `routes/upload.ts` may still be red (rewired in Task 14). Confirm no handler errors.

- [ ] **Step 5: Commit**

```bash
git add packages/worker/src/adapters/discord/handler.ts packages/worker/test/adapters/discord-initiate.test.ts
git commit -m "feat(discord): /發起繳費 admin-gated modal + modal-submit → initiateBillingOpened"
```

---

### Task 13: Slash command registration script

**Files:**
- Create: `packages/worker/scripts/register-commands.mjs`
- Modify: `packages/worker/package.json` (add a `register` script)

- [ ] **Step 1: Write the script**

```js
// Register guild slash commands for ChipPot. Reads DISCORD_BOT_TOKEN + DISCORD_APPLICATION_ID
// from packages/worker/.dev.vars (gitignored) and DISCORD_GUILD_ID from env or .dev.vars.
//   node scripts/register-commands.mjs           (uses .dev.vars)
//   DISCORD_GUILD_ID=123 node scripts/register-commands.mjs
import { readFileSync } from "node:fs";

function loadDotVars(path) {
  const out = {};
  try {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"\n]*)"?\s*$/);
      if (m) out[m[1]] = m[2];
    }
  } catch {}
  return out;
}

const vars = { ...loadDotVars(new URL("../.dev.vars", import.meta.url).pathname), ...process.env };
const TOKEN = vars.DISCORD_BOT_TOKEN;
const APP_ID = vars.DISCORD_APPLICATION_ID;
const GUILD_ID = vars.DISCORD_GUILD_ID;
if (!TOKEN || !APP_ID || !GUILD_ID) {
  console.error("Need DISCORD_BOT_TOKEN, DISCORD_APPLICATION_ID, DISCORD_GUILD_ID");
  process.exit(1);
}

const commands = [
  {
    name: "繳費", type: 1,
    description: "登記本期繳費（一次涵蓋你所有訂閱，可選渠道／截圖／備註）",
    options: [
      { type: 3, name: "渠道", description: "繳費渠道", autocomplete: true, required: false },
      { type: 11, name: "截圖", description: "繳費截圖（PNG / JPG / WebP）", required: false },
      { type: 3, name: "備註", description: "備註（自由文字，僅供審核參考）", required: false },
    ],
  },
  {
    name: "發起繳費", type: 1,
    description: "（管理員）確認本期各方案金額並發出開繳通知",
    default_member_permissions: "32",
  },
];

const res = await fetch(`https://discord.com/api/v10/applications/${APP_ID}/guilds/${GUILD_ID}/commands`, {
  method: "PUT",
  headers: { authorization: `Bot ${TOKEN}`, "content-type": "application/json" },
  body: JSON.stringify(commands),
});
console.log(res.status, await res.text());
if (!res.ok) process.exit(1);
```

> Keep the command payloads here byte-for-byte in sync with `PAY_COMMAND`/`INITIATE_COMMAND` in `commands.ts`. (They're duplicated because this `.mjs` can't import the TS module without a build step.)

- [ ] **Step 2: Add the npm script** to `packages/worker/package.json` `scripts`:

```json
    "register": "node scripts/register-commands.mjs",
```

- [ ] **Step 3: Smoke test (manual, requires .dev.vars + DISCORD_GUILD_ID)**

Run: `cd packages/worker && DISCORD_GUILD_ID=<guild> pnpm register`
Expected: prints `200 [...]` with both commands. (Defer the real run to the Phase-4 deploy step if `.dev.vars` lacks the guild id.)

- [ ] **Step 4: Commit**

```bash
git add packages/worker/scripts/register-commands.mjs packages/worker/package.json
git commit -m "chore(discord): committed guild command registration script"
```

---

### ✅ Phase 3 checkpoint — Codex review

- [ ] **Run:** `cd packages/worker && pnpm test adapters` — all adapter tests green.
- [ ] **Codex review** (foreground):
  > Review ChipPot redesign Phase 3 Discord adapter. Files: packages/worker/src/adapters/discord/handler.ts, packages/worker/src/adapters/discord/commands.ts. Verify: interaction routing by type (command/component/modal-submit) and component dispatch by custom_id (button vs channel-select) are correct; the persistent button → channel-select → settle flow returns the right response types (4 message / 7 update / 9 modal / 5 deferred); `/繳費` enforces the 渠道/截圖/備註 at-least-one rule and settles all subs; `/發起繳費` authorizes via the admin_discord_ids whitelist (NOT MANAGE_GUILD) on BOTH the command and the deferred modal-submit; the modal-submit re-checks admin before mutating. Flag any auth bypass, response-type, or custom_id-parsing bug.
- [ ] Address findings one at a time, test each.

---

# PHASE 4 — Web + Admin + integration

### Task 14: Web upload route → settle + channel + at-least-one

**Files:**
- Modify: `packages/worker/src/routes/upload.ts`
- Test: `packages/worker/test/routes/upload.test.ts`

- [ ] **Step 1: Update `upload.test.ts`** for the settle-all + channel semantics

The token is now unbound and one submit settles all the user's subs. Update `beforeAll` to give the user **two** active subscriptions (SUB_A 90061, SUB_B 90062 already exist) and seed an active channel tag (id `90069`). Replace the submit tests:

```ts
it("returns period, subscriptions, and active channel tags", async () => {
  const res = await handleUploadInfo(new Request("https://x"), env, ctxFor(RAW_OK));
  const body = (await res.json()) as any;
  expect(body.valid).toBe(true);
  expect(body.channel_tags.some((t: any) => t.id === 90069)).toBe(true);
});

it("rejects an empty submission (no screenshot, note, or channel)", async () => {
  const res = await handleUpload(uploadReq(RAW_OK, {}), env, ctxFor(RAW_OK));
  expect(res.status).toBe(400);
});

it("note-only settles all of the user's period subs and spends the token", async () => {
  const res = await handleUpload(uploadReq(RAW_NOTE, { note: "LINE 末五碼 12345", declared_channel_tag_id: "90069" }), env, ctxFor(RAW_NOTE));
  expect(res.status).toBe(200);
  const body = (await res.json()) as any;
  expect(body.ok).toBe(true);
  expect(body.paid_count).toBe(2);
});

it("screenshot path shares one key across both subs", async () => {
  const res = await handleUpload(uploadReq(RAW_OK, { screenshot: pngFile(), declared_channel_tag_id: "90069" }), env, ctxFor(RAW_OK));
  expect(res.status).toBe(200);
  const body = (await res.json()) as any;
  expect(body.has_proof).toBe(1);
  expect(body.paid_count).toBe(2);
});

it("410s a used/expired token", async () => {
  const res = await handleUpload(uploadReq(RAW_USED, { note: "x" }), env, ctxFor(RAW_USED));
  expect(res.status).toBe(410);
});
```

Make the seeded tokens **unbound** (`subscription_id` NULL) — they already are in the existing seed. Keep `RAW_OK`, `RAW_USED`, `RAW_NOTE`.

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/worker && pnpm test routes/upload`
Expected: FAIL — route still imports removed functions / no channel handling.

- [ ] **Step 3: Rewrite `src/routes/upload.ts`**

```ts
import type { Env } from "../env";
import type { RouteCtx } from "../router";
import { errorResponse, json } from "../http";
import { nowUtcIso } from "../core/time";
import { hashToken, findValidUploadToken } from "../core/tokens";
import { listActiveSubscriptions, listActiveChannelTags } from "../core/db";
import {
  settleUserPeriod, assertImageOk, extForContentType,
  InvalidImage, TokenUnusable, NoEligiblePayment,
} from "../core/storage";

/** GET /upload/:token — info for the web page (user, period, subs, channel tags). */
export async function handleUploadInfo(_req: Request, env: Env, ctx: RouteCtx): Promise<Response> {
  const hash = await hashToken(ctx.params.token!);
  const tok = await findValidUploadToken(env.DB, hash, nowUtcIso());
  if (!tok) return errorResponse(404, "invalid or expired link", { valid: false });

  const user = await env.DB.prepare("SELECT display_name FROM users WHERE id = ?").bind(tok.user_id).first<{ display_name: string }>();
  const subscriptions = await listActiveSubscriptions(env.DB, tok.workspace_id, tok.user_id);
  const channel_tags = await listActiveChannelTags(env.DB, tok.workspace_id);

  return json({
    valid: true,
    period: tok.period,
    user: { display_name: user?.display_name ?? "" },
    subscriptions,
    channel_tags,
  });
}

/** POST /upload/:token — settle all the user's period subs (screenshot/note/channel: ≥1). */
export async function handleUpload(req: Request, env: Env, ctx: RouteCtx): Promise<Response> {
  const hash = await hashToken(ctx.params.token!);
  const tok = await findValidUploadToken(env.DB, hash, nowUtcIso());
  if (!tok) return errorResponse(410, "link is no longer valid", { code: "token" });

  let form: FormData;
  try { form = await req.formData(); }
  catch { return errorResponse(400, "expected a multipart form"); }

  const entry = form.get("screenshot");
  const hasFile = entry !== null && typeof entry !== "string";
  const noteRaw = form.get("note");
  const note = typeof noteRaw === "string" && noteRaw.trim() ? noteRaw.trim() : null;

  let declaredChannelTagId: number | null = null;
  const chanRaw = form.get("declared_channel_tag_id");
  if (typeof chanRaw === "string" && chanRaw.trim()) {
    const id = Number(chanRaw);
    const ok = await env.DB.prepare("SELECT 1 AS ok FROM channel_tags WHERE id = ? AND workspace_id = ? AND active = 1").bind(id, tok.workspace_id).first<{ ok: number }>();
    if (!ok) return errorResponse(400, "invalid channel");
    declaredChannelTagId = id;
  }

  if (!hasFile && !note && declaredChannelTagId === null) {
    return errorResponse(400, "請至少附上截圖、填寫備註，或選擇渠道");
  }

  let proof: { body: ArrayBuffer; ext: string; contentType: string } | null = null;
  if (hasFile) {
    const file = entry as unknown as Blob;
    const buf = await file.arrayBuffer();
    try { assertImageOk(file.type, buf.byteLength); }
    catch (e) { if (e instanceof InvalidImage) return errorResponse(400, e.message, { code: "image" }); throw e; }
    proof = { body: buf, ext: extForContentType(file.type), contentType: file.type };
  }

  try {
    const r = await settleUserPeriod(env, {
      workspaceId: tok.workspace_id, userId: tok.user_id, period: tok.period,
      source: "user_web", tokenHash: hash, declaredChannelTagId, paymentNote: note, proof,
    });
    return json({ ok: true, paid_count: r.paidCount, total_amount: r.totalAmount, has_proof: proof ? 1 : 0 });
  } catch (e) {
    if (e instanceof TokenUnusable) return errorResponse(410, "link already used", { code: "token" });
    if (e instanceof NoEligiblePayment) return errorResponse(409, "this period is already paid or finalized", { code: "payment" });
    if (e instanceof InvalidImage) return errorResponse(400, e.message, { code: "image" });
    throw e;
  }
}
```

- [ ] **Step 4: Run to verify pass + full worker typecheck (should be clean now)**

Run: `cd packages/worker && pnpm test routes/upload && pnpm typecheck`
Expected: PASS; `pnpm typecheck` clean (all removed-function references are gone).

- [ ] **Step 5: Commit**

```bash
git add packages/worker/src/routes/upload.ts packages/worker/test/routes/upload.test.ts
git commit -m "feat(web-route): upload settles all subs via settleUserPeriod; channel + at-least-one"
```

---

### Task 15: Admin route — billing/initiate, verify pre-fills declared channel, payments list declared

**Files:**
- Modify: `packages/worker/src/routes/admin.ts`
- Test: `packages/worker/test/routes/admin.test.ts`

- [ ] **Step 1: Write the failing tests** in `admin.test.ts` (match the file's existing handler-call style; it calls handlers via the router or directly — follow whatever the file does)

Add a workspace/plan/sub fixture (id-space the file already uses; if it pins workspace 1 like the route, follow that). Tests:

```ts
it("POST /admin/billing/initiate updates pending amounts and reports", async () => {
  // seed: plan P (id ...), active sub, a pending payment for the period
  const res = await callAdmin("POST", "/admin/billing/initiate", {
    period: "2027-09", amounts: [{ plan_id: <PLAN>, amount: 700 }],
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.updated_payments).toBeGreaterThanOrEqual(1);
});

it("verify pre-fills verified_channel_tag_id from declared when omitted", async () => {
  // seed a paid payment with declared_channel_tag_id = <TAG>
  const res = await callAdmin("POST", `/admin/payments/${<PAID_ID>}/verify`, {});
  const body = await res.json();
  expect(body.payment.verified_channel_tag_id).toBe(<TAG>);
});

it("payments list includes declared_channel_tag_name", async () => {
  const res = await callAdmin("GET", "/admin/payments?period=2027-09");
  const body = await res.json();
  expect(body.payments[0]).toHaveProperty("declared_channel_tag_name");
});
```

> Use the test file's existing helper for invoking admin handlers with an identity (e.g. `callAdmin`/`withIdentity`). If none exists, call the handler functions through `buildAdminRouter().handle(req, env, { identity: { email: "owner@x" } })`.

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/worker && pnpm test routes/admin`
Expected: FAIL — route + columns missing.

- [ ] **Step 3: Implement in `src/routes/admin.ts`**

Add imports:

```ts
import { initiateBillingOpened } from "../core/billing";
import { discordNotifier } from "../adapters/discord/notify";
```

Add the handler:

```ts
async function billingInitiate(req: Request, env: Env, ctx: RouteCtx): Promise<Response> {
  const ws = wsId(ctx);
  const b = await readJson<{ period?: string; amounts?: { plan_id: number; amount: number }[] }>(req);
  const period = b?.period ?? taipeiPeriod();
  if (!PERIOD_RE.test(period)) return errorResponse(400, "period must be YYYY-MM");
  if (!Array.isArray(b?.amounts)) return errorResponse(400, "amounts is required");
  for (const a of b!.amounts) {
    if (!Number.isInteger(a.plan_id) || !Number.isInteger(a.amount) || a.amount < 0) {
      return errorResponse(400, "each amount needs an integer plan_id and non-negative amount");
    }
  }
  const r = await initiateBillingOpened(
    env, ws, period, { amounts: b!.amounts }, actorOf(ctx), discordNotifier
  );
  return json({ ok: true, sent: r.sent, updated_plans: r.updatedPlans, updated_payments: r.updatedPayments });
}
```

Register it in `buildAdminRouter()`:

```ts
    .post("/admin/billing/initiate", billingInitiate)
```

Update `listPayments` to also join the declared tag — replace its SELECT:

```ts
    `SELECT p.*, u.display_name AS user_name, pl.name AS plan_name,
            ct.name AS channel_tag_name, dct.name AS declared_channel_tag_name
     FROM payments p
     JOIN subscriptions s ON s.id = p.subscription_id
     JOIN users u ON u.id = s.user_id
     JOIN plans pl ON pl.id = s.plan_id
     LEFT JOIN channel_tags ct ON ct.id = p.verified_channel_tag_id
     LEFT JOIN channel_tags dct ON dct.id = p.declared_channel_tag_id
     WHERE ${conds.join(" AND ")}
     ORDER BY p.id DESC`
```

Update `verifyPaymentHandler` to pre-fill from declared when the body omits the tag:

```ts
  const b = await readJson<{ verified_channel_tag_id?: number }>(req) ?? {};
  const tagId = b.verified_channel_tag_id ?? before.declared_channel_tag_id ?? null;
  if (tagId != null && !(await tagBelongsToWorkspace(env, before.workspace_id, tagId))) {
    return errorResponse(400, "invalid channel tag");
  }
  try {
    const after = await verifyPayment(env.DB, id, { verifiedBy: actorOf(ctx), verifiedChannelTagId: tagId });
```

- [ ] **Step 4: Run to verify pass**

Run: `cd packages/worker && pnpm test routes/admin`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/worker/src/routes/admin.ts packages/worker/test/routes/admin.test.ts
git commit -m "feat(admin-api): POST /admin/billing/initiate; verify pre-fills declared channel; list declared tag"
```

---

### Task 16: Web SPA — channel selector, settle-all, at-least-one

**Files:**
- Modify: `packages/web/src/api.ts`, `packages/web/src/App.tsx`

- [ ] **Step 1: Update `packages/web/src/api.ts`**

```ts
export interface ChannelTag { id: number; name: string; }
export interface TokenInfo {
  valid: boolean;
  period?: string;
  user?: { display_name: string };
  subscriptions?: SubscriptionChoice[];
  channel_tags?: ChannelTag[];
}
```

Replace `uploadProof` with a settle-all signature:

```ts
export async function submitPayment(
  token: string,
  blob: Blob | null,
  channelTagId: number | null,
  note: string
): Promise<UploadResult> {
  const fd = new FormData();
  if (blob) fd.append("screenshot", new File([blob], "proof.jpg", { type: "image/jpeg" }));
  if (channelTagId != null) fd.append("declared_channel_tag_id", String(channelTagId));
  if (note.trim()) fd.append("note", note.trim());
  try {
    const res = await fetch(`${API}/upload/${token}`, { method: "POST", body: fd });
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    return res.ok ? { ok: true } : { ok: false, error: body.error ?? `錯誤 ${res.status}` };
  } catch {
    return { ok: false, error: "連線失敗，請稍後再試" };
  }
}
```

Remove `fixed_subscription_id` from `TokenInfo` and the old `uploadProof`.

- [ ] **Step 2: Update `packages/web/src/App.tsx`**

Replace the subscription radio picker with a **channel `<select>`** and total display, and change the at-least-one rule to `file || note || channel`. Key changes:

- State: replace `subId` with `const [channelId, setChannelId] = useState<number | null>(null);`
- After fetch: drop the `setSubId(...)` line.
- `submit()`:

```ts
async function submit() {
  if (!token) return;
  if (!file && !note.trim() && channelId == null) {
    setError("請至少附上截圖、填寫備註，或選擇渠道");
    return;
  }
  setError(null);
  setStage("submitting");
  const blob = file ? await compressImage(file) : null;
  const res = await submitPayment(token, blob, channelId, note);
  if (res.ok) setStage("done"); else { setError(res.error ?? "上傳失敗"); setStage("ready"); }
}
```

- Render: replace the `subs.length > 1` `<fieldset>` plan picker with:

```tsx
{(info?.channel_tags?.length ?? 0) > 0 && (
  <label className="field">
    <span>繳費渠道</span>
    <select value={channelId ?? ""} onChange={(e) => setChannelId(e.target.value ? Number(e.target.value) : null)} disabled={busy}>
      <option value="">（不指定）</option>
      {info!.channel_tags!.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
    </select>
  </label>
)}
```

- The `Stub` component: show the **sum** of all subscription amounts as the period total instead of a single chosen plan. Replace `chosen` prop with `total={subs.reduce((s, x) => s + x.amount, 0)}` and render `NT${total}`.
- Submit button disabled condition: `busy || (!file && !note.trim() && channelId == null)`.
- Update the import: `import { fetchTokenInfo, submitPayment, type TokenInfo } from "./api";`

- [ ] **Step 3: Typecheck the web package**

Run: `cd packages/web && pnpm typecheck` (or `pnpm -C packages/web exec tsc --noEmit`)
Expected: PASS.

- [ ] **Step 4: Build the web package**

Run: `cd packages/web && pnpm build`
Expected: Vite build succeeds.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/api.ts packages/web/src/App.tsx
git commit -m "feat(web): channel selector + settle-all + screenshot/note/channel at-least-one"
```

---

### Task 17: Admin SPA — 發起繳費 modal, admin_discord_ids, declared channel display

**Files:**
- Modify: `packages/admin/src/api.ts`, `packages/admin/src/views/Settings.tsx`, `packages/admin/src/views/Payments.tsx`

- [ ] **Step 1: Update `packages/admin/src/api.ts`**

Add to `Payment`: `declared_channel_tag_id: number | null; declared_channel_tag_name: string | null;`. Add API methods:

```ts
  initiateBilling: (b: { period: string; amounts: { plan_id: number; amount: number }[] }) =>
    req<{ sent: boolean; updated_plans: number; updated_payments: number }>("POST", "/billing/initiate", b),
```

- [ ] **Step 2: Settings — add `admin_discord_ids` field + 發起繳費 modal**

In `Settings.tsx`:
- Add state `const [adminIds, setAdminIds] = useState("");` and in the `useEffect`: `setAdminIds((w.settings.admin_discord_ids ?? []).join(", "));`
- Add to the `save()` settings payload: `admin_discord_ids: adminIds.split(",").map((s) => s.trim()).filter(Boolean),`
- Add a field before the save button:

```tsx
<Field label="可發起繳費的管理員 Discord ID（逗號分隔）">
  <input value={adminIds} onChange={(e) => setAdminIds(e.target.value)} disabled={busy} />
</Field>
```

- Below `RebuildMessage`, add an `<InitiateBilling />` section + component:

```tsx
function InitiateBilling() {
  const plans = useAsync(() => api.plans(), []);
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className="field__label" style={{ marginTop: 18 }}>發起繳費</div>
      <button className="btn" onClick={() => setOpen(true)}>確認本期金額並發出開繳通知</button>
      {open && plans.data && <InitiateModal plans={plans.data.plans.filter((p) => p.active)} onClose={() => setOpen(false)} />}
    </>
  );
}

function InitiateModal({ plans, onClose }: { plans: { id: number; name: string; monthly_amount: number }[]; onClose: () => void }) {
  const [period, setPeriod] = useState(currentPeriod());
  const [amounts, setAmounts] = useState<Record<number, string>>(() => Object.fromEntries(plans.map((p) => [p.id, String(p.monthly_amount)])));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  async function run() {
    setBusy(true); setErr(null); setMsg(null);
    try {
      const r = await api.initiateBilling({
        period,
        amounts: plans.map((p) => ({ plan_id: p.id, amount: Number(amounts[p.id]) })),
      });
      setMsg(r.sent ? `✓ 已發出通知（更新 ${r.updated_plans} 方案 / ${r.updated_payments} 筆）` : `✓ 已更新金額（通知先前已發送）`);
    } catch (e) { setErr((e as Error).message); }
    setBusy(false);
  }
  return (
    <Modal title="發起繳費" onClose={onClose}>
      {err && <div className="error-banner">{err}</div>}
      {msg && <div style={{ color: "var(--teal)", marginBottom: 10 }}>{msg}</div>}
      <p style={{ color: "var(--muted)", fontSize: 13, margin: "0 0 12px" }}>修改金額即為該方案的新定價（下期沿用）；已繳／已驗證的紀錄不受影響。</p>
      <Field label="期別"><input value={period} onChange={(e) => setPeriod(e.target.value)} placeholder="YYYY-MM" disabled={busy} /></Field>
      {plans.map((p) => (
        <Field key={p.id} label={`${p.name} 金額`}>
          <input type="number" value={amounts[p.id] ?? ""} onChange={(e) => setAmounts((s) => ({ ...s, [p.id]: e.target.value }))} disabled={busy} />
        </Field>
      ))}
      <button className="btn btn--primary" onClick={run} disabled={busy}>發起並通知</button>
    </Modal>
  );
}
```

Add `Modal` + `currentPeriod` to the imports (`import { useAsync, Card, Field, Empty, Modal } from "../ui";` and `import { api, currentPeriod } from "../api";`). Render `<InitiateBilling />` after `<RebuildMessage />` in the Settings card.

- [ ] **Step 3: Payments — show declared channel; default verify select to declared**

In `PaymentDetail`:
- Add to the `<dl className="kv">` (after the verified `channel_tag_name` block):

```tsx
{payment.declared_channel_tag_name && (<><dt>申報渠道</dt><dd>{payment.declared_channel_tag_name}</dd></>)}
```

- Default the verify select to declared when no verified tag yet:

```tsx
const [tagId, setTagId] = useState<number | "">(payment.verified_channel_tag_id ?? payment.declared_channel_tag_id ?? "");
```

- [ ] **Step 4: Typecheck + build the admin package**

Run: `cd packages/admin && pnpm typecheck && pnpm build`
Expected: PASS; Vite build succeeds.

- [ ] **Step 5: Commit**

```bash
git add packages/admin/src/api.ts packages/admin/src/views/Settings.tsx packages/admin/src/views/Payments.tsx
git commit -m "feat(admin): 發起繳費 modal + admin_discord_ids field + declared channel display/pre-fill"
```

---

### Task 18: Full suite, deploy, register, live smoke

**Files:** none (integration/ops)

- [ ] **Step 1: Full worker suite + typecheck**

Run: `cd packages/worker && pnpm test && pnpm typecheck`
Expected: all green; typecheck clean.

- [ ] **Step 2: Apply migration to remote D1**

Run: `cd packages/worker && pnpm migrate:remote`
Expected: `0004_declared_channel_drop_unique.sql` applied.

- [ ] **Step 3: Deploy worker + both Pages SPAs**

Run: `cd packages/worker && pnpm deploy`
Then build + deploy `packages/web` and `packages/admin` per the existing deploy flow (see `docs/deploy-state.md` / README for the Pages publish commands).

- [ ] **Step 4: Register the slash commands**

Run: `cd packages/worker && DISCORD_GUILD_ID=<test-guild-id> pnpm register`
Expected: `200` and both `繳費` + `發起繳費` returned. Confirm `/發起繳費` appears in Discord.

- [ ] **Step 5: Seed `admin_discord_ids`** (so `/發起繳費` authorizes you)

In the admin Settings page, set the admin Discord IDs (your id `<your-discord-id>`) and save. Verify via `GET /admin/workspace` that `settings.admin_discord_ids` contains it.

- [ ] **Step 6: Live smoke (manual)**

1. Reset a test period to pending (admin手動補登 or override) for a user with 2 subs.
2. Press the persistent 「繳費」 button → confirm it shows both plans + total + a channel select.
3. Pick a channel → confirm ephemeral "已登記 NT$<total>（共 2 筆）"; both payments become `paid` with `declared_channel_tag_id` set (check admin Payments).
4. `/繳費 渠道:<tag>` with no screenshot → settles all; `/繳費` with nothing → "至少…".
5. `/發起繳費` as admin → modal pre-filled with prices → change one → confirm price updated (Plans) + a 開繳 notice posted + the cron won't repost (slot claimed).
6. Admin Settings 發起繳費 modal with the toggle OFF → only this period's pending amounts change, plan price unchanged.
7. Admin verify a payment → verified channel pre-filled from declared.

- [ ] **Step 7: Commit any deploy-state doc updates**

```bash
git add docs/deploy-state.md README.md
git commit -m "docs: redesign live — Discord-first payment flow, /發起繳費, declared channel"
```

---

### ✅ Phase 4 checkpoint — Codex final review

- [ ] **Codex review** (foreground):
  > Final review of ChipPot Discord-first redesign: web upload route (settle-all + at-least-one + token atomicity), admin billing/initiate endpoint (validation + actor audit), verify pre-fill from declared channel, payments list declared join. Files: packages/worker/src/routes/upload.ts, packages/worker/src/routes/admin.ts. Confirm no regression vs the prior single-payment behavior and that the at-least-one rule + token one-time guarantee hold.
- [ ] Address findings; re-run `pnpm test`; redeploy if code changed.

---

## Self-Review (plan vs spec)

**Spec coverage:**
- 繳費預設走 Discord（按鈕→渠道→送出，不給網頁連結）→ Tasks 9–10 (button no longer issues a link; channel-select settle).
- 截圖可選 + 渠道 + 至少一項（B/C）→ Tasks 11 (slash), 14/16 (web).
- 按鈕渠道必選（min_values=1）→ Task 9 `channelSelectRow`.
- 多訂閱加總（一次送出標記全部）→ Tasks 5–6 `settleUserPeriod`, used by 10/11/14.
- 已繳清 ephemeral 明說 → Task 10 (`已登記繳費，無需重複操作`).
- 移除 screenshot_key 唯一索引 + 共用 key → Task 1 + Tasks 5/6.
- Retention 引用計數 → Task 8.
- `payments.declared_channel_tag_id` + 驗證帶入 → Task 1 (col), 15 (verify pre-fill), 17 (UI).
- `settings.admin_discord_ids` 白名單授權 → Task 2 + Task 12 (`isAdmin`) + Task 17 (UI).
- 發起繳費（Discord modal + 後台按鈕）+ 確認金額 → Tasks 7, 12, 17 (no toggle — any change is the new price, owner decision).
- 發起更新方案現價 + 改 pending 金額 + 凍結 paid + 通知 + 去重 → Task 7.
- cron 去重（手動發起後不重發）→ Task 7 claims the shared `billing_opened` slot (no cron change needed); verified in billing-initiate.test.
- 對帳看板用 payments.amount，不受改價影響 → unchanged (reconcile.ts already sums `payments.amount`); 申報渠道顯示 → Task 17.

**Placeholder scan:** none — every code step has full code. The one intentional "implemented later" is `applyTokenSettle`'s stub in Task 5, filled in Task 6 (explicitly sequenced).

**Type consistency:** `settleUserPeriod`/`SettleInput`/`SettleResult`, `initiateBillingOpened`/`InitiateInput`/`PlanAmount`, `listActiveChannelTags`/`listSettleablePayments`, `declared_channel_tag_id`, custom_id prefixes (`chippot:pay`/`chippot:paysel`/`chippot:initiate`), and response-type constants (`RT_UPDATE_MESSAGE=7`, `RT_MODAL=9`, `IT_MODAL_SUBMIT=5`) are used identically across tasks.

**Known mid-phase red state:** after Task 6 removes the old helpers, `pnpm typecheck` for the worker is red until Tasks 11–14 rewire `handler.ts`/`upload.ts`. Each task's tests pass in isolation; full typecheck returns to green at Task 14.
