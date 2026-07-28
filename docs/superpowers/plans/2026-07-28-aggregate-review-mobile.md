# Aggregate Review + Mobile Payments (issues #27 & #26) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A payment-submission notification deep-links the owner to one member × one period review screen — shared screenshot once, every settled row listed, one 一鍵全部核准 button — and the whole payments review surface (list + detail modal + this new view) is usable on a phone.

**Architecture:** The backend gains one new capability (`POST /admin/payments/verify-all`, backed by a `verifyUserPeriod` core function that loops the existing guarded single-payment transition) and two new read filters on `GET /admin/payments` (`user_id`, `id`), so the frontend can fetch exactly the rows it needs instead of the whole table. `payment-notify` stops linking to `paymentIds[0]` and links to the member × period instead; the admin SPA parses both the new and the old link shape. On the frontend, `PaymentDetail` moves into its own file so a new `MemberReview` view can reuse it, and mobile support is plain CSS in `styles.css`: the payments table gets an opt-in `.tbl-cards` class that turns rows into stacked cards below 720px, and `.modal` becomes a bottom sheet at the same breakpoint.

**Tech Stack:** TypeScript; Cloudflare Workers + D1 (hand-rolled router in `packages/worker/src/router.ts`); vitest with `@cloudflare/vitest-pool-workers`; React 18 + Vite SPA with hash routing (`packages/admin`); one hand-written stylesheet, no CSS framework.

## Global Constraints

- TDD. The worker's vitest suite is the safety net: **243 tests pass on main today and must all still pass**; every new backend behavior (bulk verify, notify link shape, list filters) gets real tests that mirror the style of the neighbouring test files.
- The admin package has **no frontend test infra — do not invent any**. Its gates are `pnpm --filter @chippot/admin typecheck` and `pnpm --filter @chippot/admin build`, plus the explicit manual 375px checks in Task 9.
- **NEVER modify `packages/worker/wrangler.toml`.** `ADMIN_ORIGIN` already exists there as a `[vars]` value and is read via `packages/worker/src/env.ts`; no config change is needed for this work.
- Public repo: no secrets, no new real origins. `https://admin.panspace.dev` / `https://pay.panspace.dev` are already committed as the owner's values — do not add others.
- Follow existing repo conventions; YAGNI. Conventional commits (`feat(admin): …`, `feat(worker): …`, `fix(admin): …`), zh-TW allowed in commit subjects. **All user-facing UI copy is zh-TW.**
- The PR body must contain `Closes #27` and `Closes #26`.
- **Rebase on latest `main` before starting.** A separate small PR (#29) lands first on the same table and is a prerequisite of Task 7 — see "Coordination" below.

## Coordination: what PR #29 changes before you start

PR #29 lands first and rewrites the payments table columns in `packages/admin/src/views/Payments.tsx`. Its end state, which THIS plan is written against:

- Final columns: `成員 | 方案 | 期別 | 金額 | 狀態 | 申報渠道 | 憑證 (rendered only when R2 is configured) | (actions)`
- The `來源` column is **removed** (the raw `p.source` string is no longer printed in the table).
- The loading/empty rows use a **dynamic `colSpan`** instead of the hard-coded `8` on main today.

Current `main` does **not** yet reflect this. So: `git pull` first, confirm the table has a `申報渠道` column and no `來源` column, and only then start. Task 7 adds `data-label` attributes to whatever cells the rebased file has — it must not change the column set.

## File Structure

**Worker (`packages/worker`)**

| File | Responsibility after this plan |
|---|---|
| `src/core/payments.ts` | Payment state machine + per-payment transitions. **Gains** `verifyUserPeriod()` — the member × period bulk verify, built on the existing guarded `verifyPayment`. |
| `src/routes/admin.ts` | All admin REST endpoints. **Gains** `user_id` / `id` filters on `listPayments`, a `verifyAllHandler`, and one route registration. |
| `src/core/payment-notify.ts` | Builds the Bark / webhook alert. **Changes** the deep link from a single payment id to member × period. |
| `src/core/storage.ts` | `settleUserPeriod`. **Changes** one call site: passes `userId` instead of `paymentIds[0]` to the notifier. |
| `test/core/payments-verify-all.test.ts` | **New.** Core-level bulk-verify behavior (which statuses move, which don't, channel defaulting). |
| `test/routes/payments-review.test.ts` | **New.** Route-level: the two list filters and the verify-all endpoint (status codes, audits). |
| `test/core/payment-notify.test.ts` | **Modified.** Existing link assertions move to the new shape; one new test proves a 2-subscription settle sends ONE notification linking to the member × period. |

**Admin SPA (`packages/admin`)**

| File | Responsibility after this plan |
|---|---|
| `src/api.ts` | Typed client. **Gains** `Payment.user_id`, the `user_id`/`id` params on `payments()`, and `verifyAll()`. |
| `src/views/PaymentDetail.tsx` | **New (moved code).** The single-payment review modal, moved verbatim out of `Payments.tsx` so both views can use it. |
| `src/views/MemberReview.tsx` | **New.** The member × period aggregate review view (mobile-first). Owns its own fetch, bulk-verify button, per-row verify/reject, and opens `PaymentDetail` for full detail. |
| `src/views/Payments.tsx` | The payments list. **Changes**: deep-link parsing handles both link shapes, renders `MemberReview` in member mode, member name links to it, table cells get `data-label`. |
| `src/styles.css` | **Gains** two appended sections: the aggregate review styles, and the ≤720px mobile block (`.tbl-cards` card rows + modal bottom sheet). |
| `src/views/Settings.tsx` | **One line**: the notification-preview sample link uses the new shape. |

Not touched: `packages/web`, `packages/admin/index.html` (see Task 7 note on `viewport-fit`), `wrangler.toml`, migrations (no schema change — `payments` reaches its user through `subscriptions.user_id`).

## Design decisions (read before Task 1)

1. **Deep-link shape:** `#payments?user=<userId>&period=<YYYY-MM>`. Chosen over a synthetic "settlement id" because `settleUserPeriod` already knows exactly `userId` + `period`, needs no schema change, and stays meaningful if rows are later added or deleted. Old `#payments?id=<paymentId>` links still open that one payment's modal (Task 6) — admins have old pushes in their notification history.
2. **Bulk verify targets `status = 'paid'` only.** The state machine allows `pending|paid|rejected → verified`, and this respects that (it never invents a transition), but it deliberately narrows to `paid` — the 已繳待驗 review queue. A `pending` row means the member never submitted for it (a bill added after the settle, or a paused subscription), so sweeping it in would fabricate a payment; `rejected` means the ball is in the member's court. Both remain verifiable one-by-one from the same screen.
3. **Each row keeps its OWN declared channel** as the verified channel, exactly like single verify (`admin.ts` defaults `verified_channel_tag_id` to `before.declared_channel_tag_id`). There is no batch-wide channel override — nobody asked for one.
4. **Audit:** one `payment.verify` entry per row with `before`/`after` (identical to single verify, so the per-payment trail stays uniform) **plus** one summary `payment.verify_all` entry on the user, mirroring how `billing.reconcile` writes a workspace-level summary.
5. **`GET /admin/payments` gains `id` as well as `user_id`.** The legacy `?id=` deep link needs to resolve one payment that may sit outside the current filters; adding a filter to the existing list keeps one joined row shape (and one `Payment` type) instead of introducing a second single-payment GET endpoint.

---

### Task 1: `GET /admin/payments` filters — `user_id`, `id`, and `user_id` on every row

**Files:**
- Modify: `packages/worker/src/routes/admin.ts:495-516` (`listPayments`)
- Test: `packages/worker/test/routes/payments-review.test.ts` (create)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `GET /admin/payments?user_id=<int>&period=<YYYY-MM>` and `GET /admin/payments?id=<int>`; each returned row now carries `user_id: number` in addition to today's `user_name`, `plan_name`, `channel_tag_name`, `declared_channel_tag_name`. Both new params 400 on a non-positive-integer value.

- [ ] **Step 1: Branch off the rebased main**

```bash
cd /Users/poterpan/Documents/Coding/Project/chippot
git checkout main && git pull
grep -n "申報渠道" packages/admin/src/views/Payments.tsx   # must hit the table header: PR #29 has landed
git checkout -b feat/27-26-aggregate-review-mobile
```

If that `grep` finds nothing in the `<thead>`, **stop** — PR #29 has not landed yet and Task 7 has nothing to attach to.

- [ ] **Step 2: Write the failing test**

Create `packages/worker/test/routes/payments-review.test.ts`. Route tests run against the seeded default workspace 1 (`wsId()` always returns 1 in this single-tenant MVP), where `0002_seed.sql` already provides plan 1 (ChatGPT, 315) and channel tag 1 (LINE Pay). Ids in the 94xx range avoid the other test files.

```ts
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { buildAdminRouter } from "../../src/routes/admin";

const TS = "2026-05-01T00:00:00.000Z";
const WS = 1;                    // wsId() ALWAYS returns the seeded default workspace 1
const U_A = 9400, U_B = 9401;    // two members, so the user filter has something to exclude
const SUB_A1 = 9410, SUB_A2 = 9411, SUB_B1 = 9412;
const P_A1 = 9420, P_A2 = 9421, P_B1 = 9422, P_A_OTHER = 9423;
const PERIOD = "2028-03";
const router = buildAdminRouter();
const IDENT = { email: "owner@example.com" };

// Mirrors test/routes/admin.test.ts: ctx is { identity }, no workspace header (wsId ignores it).
function call(method: string, path: string, body?: unknown) {
  const init: RequestInit = { method };
  if (body !== undefined) { init.body = JSON.stringify(body); init.headers = { "content-type": "application/json" }; }
  return router.handle(new Request(`https://x${path}`, init), env, { identity: IDENT });
}

function sub(id: number, userId: number) {
  return env.DB.prepare(
    `INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?)`
  ).bind(id, WS, userId, 1, "2028-01-01", 5, TS, TS);
}

// One shared screenshot key across a member's rows — that is what a single settle produces.
function pay(id: number, subId: number, period: string, status: string, declaredTag: number | null) {
  return env.DB.prepare(
    `INSERT INTO payments (id,workspace_id,subscription_id,period,period_start,period_end,due_date,amount,
        status,source,declared_channel_tag_id,has_proof,screenshot_key,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(id, WS, subId, period, `${period}-01`, `${period}-28`, `${period}-05`, 315,
         status, "user_slash", declaredTag, 1, "shot-9420", TS, TS);
}

beforeAll(async () => {
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO users (id,workspace_id,display_name,created_at,updated_at) VALUES (?,?,?,?,?)`).bind(U_A, WS, "阿明", TS, TS),
    env.DB.prepare(`INSERT INTO users (id,workspace_id,display_name,created_at,updated_at) VALUES (?,?,?,?,?)`).bind(U_B, WS, "小華", TS, TS),
    sub(SUB_A1, U_A), sub(SUB_A2, U_A), sub(SUB_B1, U_B),
    pay(P_A1, SUB_A1, PERIOD, "paid", 1),      // declared LINE Pay
    pay(P_A2, SUB_A2, PERIOD, "paid", null),   // no declared channel
    pay(P_B1, SUB_B1, PERIOD, "paid", 1),      // another member, same period
    pay(P_A_OTHER, SUB_A1, "2028-04", "paid", 1), // same member, another period
  ]);
});

describe("GET /admin/payments filters", () => {
  it("user_id + period returns only that member's rows for that period", async () => {
    const res = await call("GET", `/admin/payments?user_id=${U_A}&period=${PERIOD}`);
    expect(res!.status).toBe(200);
    const ids = ((await res!.json()) as any).payments.map((p: any) => p.id).sort();
    expect(ids).toEqual([P_A1, P_A2]);
  });

  it("returns user_id on every row so the UI can link to a member's review", async () => {
    const res = await call("GET", `/admin/payments?user_id=${U_A}&period=${PERIOD}`);
    const rows = ((await res!.json()) as any).payments;
    expect(rows.every((p: any) => p.user_id === U_A)).toBe(true);
  });

  it("id resolves exactly one payment, joined like the list (legacy deep link)", async () => {
    const res = await call("GET", `/admin/payments?id=${P_B1}`);
    const rows = ((await res!.json()) as any).payments;
    expect(rows.length).toBe(1);
    expect(rows[0].id).toBe(P_B1);
    expect(rows[0].user_name).toBe("小華");
    expect(rows[0].declared_channel_tag_name).toBe("LINE Pay");
  });

  it("400s on a non-positive-integer id or user_id", async () => {
    expect((await call("GET", "/admin/payments?id=abc"))!.status).toBe(400);
    expect((await call("GET", "/admin/payments?user_id=0"))!.status).toBe(400);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter @chippot/worker test payments-review`
Expected: FAIL — the `user_id` filter is ignored so the first test returns 3+ rows, `p.user_id` is `undefined`, and the garbage-value calls return 200 instead of 400.

- [ ] **Step 4: Implement the filters**

In `packages/worker/src/routes/admin.ts`, replace `listPayments` (currently lines 495-516) with:

```ts
/**
 * The review list. Filters are all optional and combine:
 *   period / status — the admin's toolbar filters
 *   user_id         — one member's rows (the member × period aggregate review view)
 *   id              — one specific payment, joined exactly like the list, so a legacy
 *                     "#payments?id=" notification link can resolve a row that sits outside
 *                     the current toolbar filters without a second endpoint shape.
 */
async function listPayments(_req: Request, env: Env, ctx: RouteCtx): Promise<Response> {
  const ws = wsId(ctx);
  const period = ctx.url.searchParams.get("period");
  const status = ctx.url.searchParams.get("status");
  const conds = ["p.workspace_id = ?"];
  const binds: unknown[] = [ws];
  if (period) { conds.push("p.period = ?"); binds.push(period); }
  if (status) { conds.push("p.status = ?"); binds.push(status); }
  for (const [param, column] of [["id", "p.id"], ["user_id", "s.user_id"]] as const) {
    const raw = ctx.url.searchParams.get(param);
    if (raw === null || raw === "") continue;
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) return errorResponse(400, `${param} must be a positive integer`);
    conds.push(`${column} = ?`);
    binds.push(n);
  }
  const { results } = await env.DB.prepare(
    `SELECT p.*, s.user_id AS user_id, u.display_name AS user_name, pl.name AS plan_name,
            ct.name AS channel_tag_name, dct.name AS declared_channel_tag_name
     FROM payments p
     JOIN subscriptions s ON s.id = p.subscription_id
     JOIN users u ON u.id = s.user_id
     JOIN plans pl ON pl.id = s.plan_id
     LEFT JOIN channel_tags ct ON ct.id = p.verified_channel_tag_id
     LEFT JOIN channel_tags dct ON dct.id = p.declared_channel_tag_id
     WHERE ${conds.join(" AND ")}
     ORDER BY CASE p.status WHEN 'paid' THEN 0 WHEN 'rejected' THEN 1 WHEN 'verified' THEN 2 ELSE 3 END, p.id DESC`
  ).bind(...binds).all();
  return json({ payments: results });
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @chippot/worker test payments-review`
Expected: PASS (4 tests).

- [ ] **Step 6: Run the whole worker suite — nothing else regressed**

Run: `pnpm --filter @chippot/worker test`
Expected: PASS, 247 tests (243 baseline + 4). The existing `admin.test.ts` list assertions must stay green — `s.user_id AS user_id` is an added column, and `payments` has no `user_id` of its own to collide with.

- [ ] **Step 7: Commit**

```bash
git add packages/worker/src/routes/admin.ts packages/worker/test/routes/payments-review.test.ts
git commit -m "feat(worker): filter /admin/payments by user_id and id, return user_id per row"
```

---

### Task 2: core `verifyUserPeriod` — verify a member's whole period

**Files:**
- Modify: `packages/worker/src/core/payments.ts` (append after `verifyPayment`, currently ends line 137)
- Test: `packages/worker/test/core/payments-verify-all.test.ts` (create)

**Interfaces:**
- Consumes: existing `getPayment`, `verifyPayment`, `InvalidPaymentTransition`, `PaymentRow` from the same file.
- Produces:
  ```ts
  export interface VerifyUserPeriodOpts { workspaceId: number; userId: number; period: string; verifiedBy: string }
  export interface VerifyUserPeriodResult { verified: { before: PaymentRow; after: PaymentRow }[] }
  export function verifyUserPeriod(db: D1Database, o: VerifyUserPeriodOpts): Promise<VerifyUserPeriodResult>
  ```
  Task 3 consumes `result.verified` to write audits and to count.

- [ ] **Step 1: Write the failing test**

Create `packages/worker/test/core/payments-verify-all.test.ts`. Core tests use their own isolated workspace (storage rolls back per test *file*, and `it` blocks in a file share state and run in order — same convention as `test/core/payments-unverify.test.ts`).

```ts
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { verifyUserPeriod, getPayment } from "../../src/core/payments";

const TS = "2026-05-01T00:00:00.000Z";
const WS = 9500, OTHER_WS = 9599;
const U = 9500, U2 = 9501, PLAN = 9500;
const TAG = 9500, FOREIGN_TAG = 9599;
const SUB_TAG = 9510, SUB_NOTAG = 9511, SUB_PENDING = 9512, SUB_REJECTED = 9513,
      SUB_VERIFIED = 9514, SUB_FOREIGN = 9515, SUB_U2 = 9516;
const P_TAG = 9520, P_NOTAG = 9521, P_PENDING = 9522, P_REJECTED = 9523,
      P_VERIFIED = 9524, P_FOREIGN = 9525, P_OTHER_PERIOD = 9526, P_OTHER_USER = 9527;
const PERIOD = "2028-06";
const ACTOR = "owner@example.com";

function sub(id: number, userId: number) {
  return env.DB.prepare(
    `INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?)`
  ).bind(id, WS, userId, PLAN, "2028-01-01", 5, TS, TS);
}

function pay(id: number, subId: number, period: string, status: string, declaredTag: number | null,
             verifiedBy: string | null = null) {
  return env.DB.prepare(
    `INSERT INTO payments (id,workspace_id,subscription_id,period,period_start,period_end,due_date,amount,
        status,source,declared_channel_tag_id,verified_by,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(id, WS, subId, period, `${period}-01`, `${period}-30`, `${period}-05`, 315,
         status, "user_slash", declaredTag, verifiedBy, TS, TS);
}

beforeAll(async () => {
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO workspaces (id,name,owner_id,channel_type,billing_day,settings,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(WS, "W", "o", "discord", 5, "{}", TS, TS),
    env.DB.prepare(`INSERT INTO workspaces (id,name,owner_id,channel_type,billing_day,settings,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(OTHER_WS, "Other", "o", "discord", 5, "{}", TS, TS),
    env.DB.prepare(`INSERT INTO channel_tags (id,workspace_id,name,sort_order,created_at) VALUES (?,?,?,?,?)`).bind(TAG, WS, "LINE Pay", 0, TS),
    env.DB.prepare(`INSERT INTO channel_tags (id,workspace_id,name,sort_order,created_at) VALUES (?,?,?,?,?)`).bind(FOREIGN_TAG, OTHER_WS, "別家渠道", 0, TS),
    env.DB.prepare(`INSERT INTO users (id,workspace_id,display_name,created_at,updated_at) VALUES (?,?,?,?,?)`).bind(U, WS, "阿明", TS, TS),
    env.DB.prepare(`INSERT INTO users (id,workspace_id,display_name,created_at,updated_at) VALUES (?,?,?,?,?)`).bind(U2, WS, "小華", TS, TS),
    env.DB.prepare(`INSERT INTO plans (id,workspace_id,name,provider,monthly_amount,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`).bind(PLAN, WS, "ChatGPT", "openai", 315, TS, TS),
    sub(SUB_TAG, U), sub(SUB_NOTAG, U), sub(SUB_PENDING, U), sub(SUB_REJECTED, U),
    sub(SUB_VERIFIED, U), sub(SUB_FOREIGN, U), sub(SUB_U2, U2),
    pay(P_TAG, SUB_TAG, PERIOD, "paid", TAG),
    pay(P_NOTAG, SUB_NOTAG, PERIOD, "paid", null),
    pay(P_PENDING, SUB_PENDING, PERIOD, "pending", null),
    pay(P_REJECTED, SUB_REJECTED, PERIOD, "rejected", TAG),
    pay(P_VERIFIED, SUB_VERIFIED, PERIOD, "verified", TAG, "admin"),
    pay(P_FOREIGN, SUB_FOREIGN, PERIOD, "paid", FOREIGN_TAG),
    pay(P_OTHER_PERIOD, SUB_TAG, "2028-07", "paid", TAG),
    pay(P_OTHER_USER, SUB_U2, PERIOD, "paid", TAG),
  ]);
});

describe("verifyUserPeriod (一鍵全部核准)", () => {
  it("verifies every 'paid' row of that member × period, each keeping its own declared channel", async () => {
    const r = await verifyUserPeriod(env.DB, { workspaceId: WS, userId: U, period: PERIOD, verifiedBy: ACTOR });
    expect(r.verified.map((v) => v.after.id).sort()).toEqual([P_TAG, P_NOTAG, P_FOREIGN].sort());
    const withTag = await getPayment(env.DB, P_TAG);
    expect(withTag?.status).toBe("verified");
    expect(withTag?.verified_channel_tag_id).toBe(TAG);
    expect(withTag?.verified_by).toBe(ACTOR);
    expect((await getPayment(env.DB, P_NOTAG))?.verified_channel_tag_id).toBeNull();
    // before/after pairs feed the per-payment audit entries the route writes
    expect(r.verified.every((v) => v.before.status === "paid" && v.after.status === "verified")).toBe(true);
  });

  it("drops a declared tag belonging to another workspace instead of storing it", async () => {
    const p = await getPayment(env.DB, P_FOREIGN);
    expect(p?.status).toBe("verified");
    expect(p?.verified_channel_tag_id).toBeNull();
  });

  it("leaves pending, rejected and already-verified rows untouched", async () => {
    expect((await getPayment(env.DB, P_PENDING))?.status).toBe("pending");
    expect((await getPayment(env.DB, P_REJECTED))?.status).toBe("rejected");
    expect((await getPayment(env.DB, P_VERIFIED))?.verified_by).toBe("admin"); // not re-stamped
  });

  it("never crosses into another period or another member", async () => {
    expect((await getPayment(env.DB, P_OTHER_PERIOD))?.status).toBe("paid");
    expect((await getPayment(env.DB, P_OTHER_USER))?.status).toBe("paid");
  });

  it("is idempotent: a second run finds nothing to verify", async () => {
    const r = await verifyUserPeriod(env.DB, { workspaceId: WS, userId: U, period: PERIOD, verifiedBy: ACTOR });
    expect(r.verified).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @chippot/worker test payments-verify-all`
Expected: FAIL — `verifyUserPeriod` is not exported from `src/core/payments.ts`.

- [ ] **Step 3: Implement `verifyUserPeriod`**

Append to `packages/worker/src/core/payments.ts`, directly after `verifyPayment` (which currently ends at line 137):

```ts
export interface VerifyUserPeriodOpts {
  workspaceId: number;
  userId: number;
  period: string;
  verifiedBy: string;
}

export interface VerifyUserPeriodResult {
  /** One entry per row actually verified, so the caller can audit each before/after. */
  verified: { before: PaymentRow; after: PaymentRow }[];
}

/**
 * 一鍵全部核准: verify every payment this member has in the period that is waiting for review
 * (status 'paid' — the 已繳待驗 queue). One member submit settles one row per active subscription
 * sharing one screenshot, so the owner should be able to approve them together.
 *
 * Deliberately narrower than the state machine allows: 'pending' means the member never submitted
 * for that bill (added after the settle, or a paused sub) and 'rejected' means the ball is in the
 * member's court, so neither is swept in — both stay verifiable one-by-one. Each row keeps its OWN
 * declared channel as the verified channel, exactly like single verify; a declared tag from another
 * workspace is dropped to NULL rather than failing the batch (the single-verify handler 400s on one,
 * so we must never store one either). Rows that lose the guarded UPDATE race to a concurrent verify
 * are silently skipped.
 */
export async function verifyUserPeriod(
  db: D1Database,
  o: VerifyUserPeriodOpts
): Promise<VerifyUserPeriodResult> {
  const targets = await db
    .prepare(
      `SELECT p.id AS id FROM payments p
       JOIN subscriptions s ON s.id = p.subscription_id
       WHERE p.workspace_id = ? AND p.period = ? AND p.status = 'paid' AND s.user_id = ?
       ORDER BY p.id`
    )
    .bind(o.workspaceId, o.period, o.userId)
    .all<{ id: number }>();
  const ownTags = await db
    .prepare("SELECT id FROM channel_tags WHERE workspace_id = ?")
    .bind(o.workspaceId)
    .all<{ id: number }>();
  const tagIds = new Set(ownTags.results.map((t) => t.id));

  const verified: { before: PaymentRow; after: PaymentRow }[] = [];
  for (const { id } of targets.results) {
    const before = await getPayment(db, id);
    if (!before) continue;
    const declared = before.declared_channel_tag_id;
    const tagId = declared != null && tagIds.has(declared) ? declared : null;
    try {
      const after = await verifyPayment(db, id, { verifiedBy: o.verifiedBy, verifiedChannelTagId: tagId });
      verified.push({ before, after });
    } catch (e) {
      if (!(e instanceof InvalidPaymentTransition)) throw e; // raced with another verify → skip
    }
  }
  return { verified };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @chippot/worker test payments-verify-all`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/worker/src/core/payments.ts packages/worker/test/core/payments-verify-all.test.ts
git commit -m "feat(worker): verifyUserPeriod — verify a member's whole period, each row keeping its declared channel"
```

---

### Task 3: `POST /admin/payments/verify-all` endpoint

**Files:**
- Modify: `packages/worker/src/routes/admin.ts` (import line 8; new handler next to `verifyPaymentHandler` at line 518; route registration in `buildAdminRouter` near line 782)
- Test: `packages/worker/test/routes/payments-review.test.ts` (append)

**Interfaces:**
- Consumes: `verifyUserPeriod(db, { workspaceId, userId, period, verifiedBy })` → `{ verified: { before, after }[] }` from Task 2.
- Produces: `POST /admin/payments/verify-all` with JSON body `{ user_id: number, period: string }` → `200 { ok: true, verified: number, payment_ids: number[] }`; `400` on a missing/invalid `user_id` or a period that is not `YYYY-MM`; `404` for a member outside the workspace. Writes one `payment.verify` audit per row plus one `payment.verify_all` audit on the user. Task 5's `api.verifyAll` calls it.

- [ ] **Step 1: Write the failing test**

Append to `packages/worker/test/routes/payments-review.test.ts` (after the existing `describe`). Add this helper right below the `call()` helper at the top of the file:

```ts
async function auditCount(action: string, entityId: number): Promise<number> {
  const r = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM audit_logs WHERE action = ? AND entity_id = ? AND actor = ?"
  ).bind(action, entityId, IDENT.email).first<{ n: number }>();
  return r!.n;
}
```

and append this `describe` **last in the file** (it flips `P_A1`/`P_A2` to `verified`, and `it` blocks share state within a file):

```ts
describe("POST /admin/payments/verify-all", () => {
  it("verifies the member's whole period in one call, each row keeping its declared channel", async () => {
    const res = await call("POST", "/admin/payments/verify-all", { user_id: U_A, period: PERIOD });
    expect(res!.status).toBe(200);
    const b = (await res!.json()) as any;
    expect(b.verified).toBe(2);
    expect(b.payment_ids.sort()).toEqual([P_A1, P_A2]);
    const rows = await env.DB.prepare(
      "SELECT id, status, verified_channel_tag_id, verified_by FROM payments WHERE id IN (?,?)"
    ).bind(P_A1, P_A2).all<{ id: number; status: string; verified_channel_tag_id: number | null; verified_by: string }>();
    expect(rows.results.every((r) => r.status === "verified")).toBe(true);
    expect(rows.results.every((r) => r.verified_by === IDENT.email)).toBe(true);
    expect(rows.results.find((r) => r.id === P_A1)!.verified_channel_tag_id).toBe(1); // its own declared tag
    expect(rows.results.find((r) => r.id === P_A2)!.verified_channel_tag_id).toBeNull();
  });

  it("audits every payment plus one batch summary on the member", async () => {
    expect(await auditCount("payment.verify", P_A1)).toBe(1);
    expect(await auditCount("payment.verify", P_A2)).toBe(1);
    const batch = await env.DB.prepare(
      "SELECT entity_type, after_json FROM audit_logs WHERE action = 'payment.verify_all' AND entity_id = ?"
    ).bind(U_A).first<{ entity_type: string; after_json: string }>();
    expect(batch!.entity_type).toBe("user");
    expect(JSON.parse(batch!.after_json)).toMatchObject({ period: PERIOD, verified: 2 });
  });

  it("leaves the other member's row for the same period alone", async () => {
    const row = await env.DB.prepare("SELECT status FROM payments WHERE id = ?").bind(P_B1).first<{ status: string }>();
    expect(row?.status).toBe("paid");
  });

  it("is a no-op on a second call", async () => {
    const res = await call("POST", "/admin/payments/verify-all", { user_id: U_A, period: PERIOD });
    expect(res!.status).toBe(200);
    expect(((await res!.json()) as any).verified).toBe(0);
  });

  it("400s on a missing user_id or a malformed period", async () => {
    expect((await call("POST", "/admin/payments/verify-all", { period: PERIOD }))!.status).toBe(400);
    expect((await call("POST", "/admin/payments/verify-all", { user_id: U_A, period: "2028-3" }))!.status).toBe(400);
  });

  it("404s for a member outside the workspace", async () => {
    expect((await call("POST", "/admin/payments/verify-all", { user_id: 999999, period: PERIOD }))!.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @chippot/worker test payments-review`
Expected: FAIL — the router has no `/admin/payments/verify-all`, so `router.handle` returns `null` and `res!.status` throws / is undefined.

- [ ] **Step 3: Implement the handler and register the route**

In `packages/worker/src/routes/admin.ts`, extend the core-payments import on line 8:

```ts
import { getPayment, verifyPayment, rejectPayment, overrideAmount, unverifyPayment, verifyUserPeriod, InvalidPaymentTransition } from "../core/payments";
```

Add the handler immediately after `verifyPaymentHandler` (which ends at line 536):

```ts
/**
 * 一鍵全部核准: verify every reviewable payment this member has in the period. A single member
 * submit settles one row per active subscription (one shared screenshot), so the review that used
 * to take N clicks is one call. Channel defaulting and the state machine match single verify — see
 * verifyUserPeriod. Audit trail: one payment.verify per row (identical to single verify) plus one
 * payment.verify_all summary on the member, mirroring billing.reconcile's workspace-level summary.
 */
async function verifyAllHandler(req: Request, env: Env, ctx: RouteCtx): Promise<Response> {
  const ws = wsId(ctx);
  const b = await readJson<{ user_id?: number; period?: string }>(req) ?? {};
  const userId = b.user_id;
  if (!Number.isInteger(userId) || (userId as number) <= 0) return errorResponse(400, "user_id must be a positive integer");
  if (!b.period || !PERIOD_RE.test(b.period)) return errorResponse(400, "period must be YYYY-MM");
  const user = await env.DB.prepare("SELECT id FROM users WHERE id = ? AND workspace_id = ?")
    .bind(userId, ws).first<{ id: number }>();
  if (!user) return errorResponse(404, "not found");

  const actor = actorOf(ctx);
  const { verified } = await verifyUserPeriod(env.DB, {
    workspaceId: ws, userId: userId as number, period: b.period, verifiedBy: actor,
  });
  for (const v of verified) {
    await writeAudit(env.DB, {
      workspaceId: ws, actor, action: "payment.verify", entityType: "payment", entityId: v.after.id,
      before: v.before, after: v.after,
    });
  }
  const paymentIds = verified.map((v) => v.after.id);
  await writeAudit(env.DB, {
    workspaceId: ws, actor, action: "payment.verify_all", entityType: "user", entityId: userId as number,
    after: { period: b.period, verified: paymentIds.length, payment_ids: paymentIds },
  });
  return json({ ok: true, verified: paymentIds.length, payment_ids: paymentIds });
}
```

Register it in `buildAdminRouter()` next to the other payments routes — put it right after `.post("/admin/payments/manual", manualPayment)` (line 782). It is a 3-segment path (`admin/payments/verify-all`) so it cannot collide with the 4-segment `:id` routes, and `manual` is the existing precedent for a non-`:id` sub-path:

```ts
    .post("/admin/payments/manual", manualPayment)
    .post("/admin/payments/verify-all", verifyAllHandler)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @chippot/worker test payments-review`
Expected: PASS (10 tests: 4 from Task 1 + 6 here).

- [ ] **Step 5: Run the whole worker suite**

Run: `pnpm --filter @chippot/worker test`
Expected: PASS, 258 tests (243 + 4 + 5 + 6).

- [ ] **Step 6: Commit**

```bash
git add packages/worker/src/routes/admin.ts packages/worker/test/routes/payments-review.test.ts
git commit -m "feat(worker): POST /admin/payments/verify-all — 一鍵核准某成員某期的全部繳費"
```

---

### Task 4: notification deep link → member × period

**Files:**
- Modify: `packages/worker/src/core/payment-notify.ts:55-62` (`PaymentNotifyInput`) and `:79-80` (link construction)
- Modify: `packages/worker/src/core/storage.ts:237-245` (the notify call site)
- Test: `packages/worker/test/core/payment-notify.test.ts` (modify existing assertions, add one describe)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `PaymentNotifyInput` now `{ workspaceId, payer, amount, period, userId, paidCount }` — the `paymentId` field is **replaced by `userId`** (no other module reads it). The emitted `admin_url` is `${ADMIN_ORIGIN}/#payments?user=<userId>&period=<YYYY-MM>`; Task 6's SPA parses it. Bark's `?url=` and the per-host webhook body shapes are unchanged.

- [ ] **Step 1: Write the failing test**

Two edits in `packages/worker/test/core/payment-notify.test.ts`.

(a) Update the shared fixtures and the four existing link assertions to the new shape:

```ts
// line 37 — the notifier now takes the member id, not a single payment row id
const baseInput = { payer: "廖清筆", amount: 1573, period: "2026-06", userId: 4242, paidCount: 2 };

// line 40
const V: PaymentNotifyVars = { payer: "廖清筆", amount: "1,573", period: "2026-06", admin_url: "https://admin.x/#payments?user=42&period=2026-06" };
```

Then, in the same file, replace each old link literal:

| Line | Old | New |
|---|---|---|
| 47 | `"→ https://admin.x/#payments?id=9"` | `"→ https://admin.x/#payments?user=42&period=2026-06"` |
| 53 | `"https://admin.x/#payments?id=9"` (buildBarkUrl arg) | `"https://admin.x/#payments?user=42&period=2026-06"` |
| 56 | `encodeURIComponent("https://admin.x/#payments?id=9")` | `encodeURIComponent("https://admin.x/#payments?user=42&period=2026-06")` |
| 109 | `encodeURIComponent("https://admin.panspace.dev/#payments?id=1234")` | `encodeURIComponent("https://admin.panspace.dev/#payments?user=4242&period=2026-06")` |
| 120 | `"審核 → https://admin.x/#payments?id=1234"` | `"審核 → https://admin.x/#payments?user=4242&period=2026-06"` |
| 129 | `"審核 → https://admin.x/#payments?id=1234"` | `"審核 → https://admin.x/#payments?user=4242&period=2026-06"` |
| 220 | ``expect(body.content).toContain(`#payments?id=${r.paymentIds[0]}`)`` | ``expect(body.content).toContain(`#payments?user=${USER}&period=${PERIOD}`)`` |

(b) Append a new describe at the end of the file proving the aggregate case — two subscriptions settled by one submit produce ONE notification pointing at the member × period, not at a row:

```ts
describe("settleUserPeriod → aggregate deep link (member × period, not one row)", () => {
  const WS = 70030, USER = 70031, PLAN_A = 70032, PLAN_B = 70033, SUB_A = 70034, SUB_B = 70035;
  const PERIOD = "2027-12";
  beforeAll(async () => {
    const pending = (subId: number) => env.DB
      .prepare(`INSERT INTO payments (workspace_id,subscription_id,period,period_start,period_end,due_date,amount,status,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(WS, subId, PERIOD, `${PERIOD}-01`, `${PERIOD}-31`, `${PERIOD}-05`, 315, "pending", "cron", TS, TS);
    await env.DB.batch([
      ws(WS, { payment_webhook_url: "https://discord.com/api/webhooks/9/z" }),
      env.DB.prepare(`INSERT INTO users (id,workspace_id,display_name,created_at,updated_at) VALUES (?,?,?,?,?)`).bind(USER, WS, "阿德", TS, TS),
      env.DB.prepare(`INSERT INTO plans (id,workspace_id,name,provider,monthly_amount,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`).bind(PLAN_A, WS, "ChatGPT", "openai", 315, TS, TS),
      env.DB.prepare(`INSERT INTO plans (id,workspace_id,name,provider,monthly_amount,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`).bind(PLAN_B, WS, "Claude", "anthropic", 315, TS, TS),
      env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(SUB_A, WS, USER, PLAN_A, "2027-01-01", 1, TS, TS),
      env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(SUB_B, WS, USER, PLAN_B, "2027-01-01", 1, TS, TS),
      pending(SUB_A), pending(SUB_B),
    ]);
  });

  it("sends ONE notification whose link carries user + period and no payment id", async () => {
    const calls = capture();
    const r = await settleUserPeriod(env, {
      workspaceId: WS, userId: USER, period: PERIOD, source: "user_slash",
      declaredChannelTagId: null, paymentNote: null, proof: null,
    });
    vi.unstubAllGlobals();
    expect(r.paidCount).toBe(2); // two subscriptions settled by one submit
    expect(calls.length).toBe(1); // still exactly one push
    const body = JSON.parse(calls[0]!.init!.body as string);
    expect(body.content).toContain(`#payments?user=${USER}&period=${PERIOD}`);
    expect(body.content).not.toContain("payments?id=");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @chippot/worker test payment-notify`
Expected: FAIL — TypeScript rejects `userId` on `PaymentNotifyInput` (`paymentId` is required), and the link assertions still see `?id=`.

- [ ] **Step 3: Implement the new link shape**

In `packages/worker/src/core/payment-notify.ts`, replace `PaymentNotifyInput` (lines 55-62):

```ts
export interface PaymentNotifyInput {
  workspaceId: number;
  payer: string;
  amount: number; // raw total just settled
  period: string;
  userId: number; // deep-link target: one submit settles N rows, so we link to the member × period
  paidCount: number;
}
```

and the link construction (line 80):

```ts
    // Review deep link: the member's whole period, because one submit settles one payment row per
    // active subscription (all sharing one screenshot). The admin SPA still accepts the older
    // "#payments?id=<paymentId>" form so pushes already sitting in the owner's history keep working.
    const adminUrl = base ? `${base}/#payments?user=${input.userId}&period=${input.period}` : "";
```

In `packages/worker/src/core/storage.ts`, update the call site (lines 240-243):

```ts
    const notifying = notifyPaymentSubmitted(env, {
      workspaceId, payer: u?.display_name ?? `#${userId}`,
      amount: totalAmount, period, userId, paidCount,
    });
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @chippot/worker test payment-notify`
Expected: PASS (the file's existing tests plus the new one).

- [ ] **Step 5: Typecheck + full suite**

Run: `pnpm --filter @chippot/worker typecheck && pnpm --filter @chippot/worker test`
Expected: PASS, 259 tests. Typecheck proves no other module still passes `paymentId`.

- [ ] **Step 6: Commit**

```bash
git add packages/worker/src/core/payment-notify.ts packages/worker/src/core/storage.ts packages/worker/test/core/payment-notify.test.ts
git commit -m "feat(worker): payment alert deep-links to the member's period review, not one row"
```

---

### Task 5: admin API client + extract `PaymentDetail` (no behavior change)

**Files:**
- Modify: `packages/admin/src/api.ts:24-31` (`Payment`), `:61` (`payments`), and the `api` object (add `verifyAll`)
- Create: `packages/admin/src/views/PaymentDetail.tsx` (moved from `Payments.tsx:207-288`)
- Modify: `packages/admin/src/views/Payments.tsx` (remove the moved function, import it instead)

**Interfaces:**
- Consumes: the endpoints from Tasks 1 and 3.
- Produces:
  - `Payment` now includes `user_id: number`.
  - `api.payments(p?: { period?: string; status?: string; user_id?: number; id?: number })` → `{ payments: Payment[] }`.
  - `api.verifyAll(userId: number, period: string)` → `{ ok: boolean; verified: number; payment_ids: number[] }`.
  - `export function PaymentDetail({ payment, tags, onClose, onDone }: { payment: Payment; tags: ChannelTag[]; onClose: () => void; onDone: () => void })` from `views/PaymentDetail.tsx` — Task 6's `MemberReview` imports it.

- [ ] **Step 1: Extend the API client**

In `packages/admin/src/api.ts`, add `user_id` to the `Payment` interface (line 25 — first line of the body, next to `id`):

```ts
export interface Payment {
  id: number; user_id: number; period: string; amount: number; status: string; has_proof: number;
  screenshot_key: string | null; proof_deleted_at: string | null; payment_note: string | null;
  verified_channel_tag_id: number | null; channel_tag_name: string | null;
  declared_channel_tag_id: number | null; declared_channel_tag_name: string | null; source: string;
  rejected_reason: string | null; user_name: string; plan_name: string;
  paid_at: string | null; submitted_at: string | null; verified_by: string | null; due_date: string;
}
```

and replace the `payments` entry (line 61), adding `verifyAll` right after `verify`:

```ts
  payments: (p?: { period?: string; status?: string; user_id?: number; id?: number }) =>
    req<{ payments: Payment[] }>("GET", `/payments${qs(p)}`),
  verify: (id: number, tagId: number | null) => req("POST", `/payments/${id}/verify`, { verified_channel_tag_id: tagId }),
  verifyAll: (userId: number, period: string) =>
    req<{ ok: boolean; verified: number; payment_ids: number[] }>("POST", "/payments/verify-all", { user_id: userId, period }),
```

(`qs()` already accepts numbers and drops `undefined`.)

- [ ] **Step 2: Move `PaymentDetail` into its own file**

Create `packages/admin/src/views/PaymentDetail.tsx` with the function moved **verbatim** from `Payments.tsx:207-288` — only the imports and the `export` keyword are new:

```tsx
import { useState } from "react";
import { api, type ChannelTag, type Payment } from "../api";
import { Modal, Field, Money, StatusBadge, IconWarning } from "../ui";

export function PaymentDetail({ payment, tags, onClose, onDone }: { payment: Payment; tags: ChannelTag[]; onClose: () => void; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [tagId, setTagId] = useState<number | "">(payment.verified_channel_tag_id ?? payment.declared_channel_tag_id ?? "");
  const [reason, setReason] = useState("");
  const [amount, setAmount] = useState(String(payment.amount));

  async function run(fn: () => Promise<unknown>) {
    setBusy(true); setErr(null);
    try { await fn(); onDone(); }
    catch (e) { setErr((e as Error).message); setBusy(false); }
  }

  const canVerify = ["pending", "paid", "rejected"].includes(payment.status);
  const canReject = ["pending", "paid"].includes(payment.status);

  return (
    <Modal title={`${payment.user_name} · ${payment.plan_name} · ${payment.period}`} onClose={onClose}>
      {err && <div className="error-banner">{err}</div>}
      <dl className="kv">
        <dt>狀態</dt><dd><StatusBadge status={payment.status} /></dd>
        <dt>金額</dt><dd><Money v={payment.amount} /></dd>
        <dt>應繳日</dt><dd className="mono">{payment.due_date}</dd>
        <dt>來源</dt><dd>{payment.source}</dd>
        {payment.payment_note && (<><dt>使用者備註</dt><dd>{payment.payment_note}</dd></>)}
        {payment.declared_channel_tag_name && (<><dt>申報渠道</dt><dd>{payment.declared_channel_tag_name}</dd></>)}
        {payment.channel_tag_name && (<><dt>認定渠道</dt><dd>{payment.channel_tag_name}</dd></>)}
        {payment.rejected_reason && (<><dt>退回原因</dt><dd>{payment.rejected_reason}</dd></>)}
      </dl>

      {payment.has_proof && payment.screenshot_key && (
        <img className="proof-img" src={api.imageUrl(payment.screenshot_key)} alt="繳費截圖" />
      )}
      {payment.has_proof === 1 && !payment.screenshot_key && payment.proof_deleted_at && (
        <p style={{ color: "var(--muted)" }}>截圖已依保存期於 {payment.proof_deleted_at} 刪除（對帳資料保留）。</p>
      )}
      {!payment.has_proof && <p style={{ color: "var(--amber)" }}><IconWarning /> 無憑證，純聲明 — 請依備註與帳戶自行核對。</p>}

      <hr style={{ border: 0, borderTop: "1px solid var(--line)", margin: "18px 0" }} />

      {canVerify && (
        <Field label="認定渠道（對帳分組依據）">
          <select value={tagId} onChange={(e) => setTagId(e.target.value ? Number(e.target.value) : "")} disabled={busy}>
            <option value="">（不指定）</option>
            {tags.filter((t) => t.active).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </Field>
      )}

      <div className="btn-row">
        {canVerify && <button className="btn btn--primary" disabled={busy} onClick={() => run(() => api.verify(payment.id, tagId === "" ? null : Number(tagId)))}>標記已驗證</button>}
        {payment.status === "verified" && <button className="btn" disabled={busy} onClick={() => run(() => api.unverify(payment.id))}>撤回驗證</button>}
        {payment.screenshot_key && <button className="btn btn--danger" disabled={busy} onClick={() => run(() => api.deleteProof(payment.id))}>刪除截圖</button>}
      </div>

      {canReject && (
        <div style={{ marginTop: 16 }}>
          <Field label="退回原因（選填）"><input value={reason} onChange={(e) => setReason(e.target.value)} disabled={busy} /></Field>
          <button className="btn btn--danger" disabled={busy} onClick={() => run(() => api.reject(payment.id, reason))}>退回</button>
        </div>
      )}

      <div style={{ marginTop: 16 }}>
        <Field label="單筆覆寫金額"><input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} disabled={busy} /></Field>
        <button className="btn" disabled={busy} onClick={() => run(() => api.overrideAmount(payment.id, Number(amount)))}>更新金額</button>
      </div>

      <hr style={{ border: 0, borderTop: "1px solid var(--line)", margin: "18px 0" }} />
      <button
        className="btn btn--danger"
        disabled={busy}
        onClick={() => {
          const hasHistory = payment.status !== "pending"; // paid/verified/rejected all carry real activity
          const msg = hasHistory
            ? "這筆已有繳費／審核紀錄，刪除後將從對帳與紀錄中消失且無法復原（仍保留稽核紀錄）。確定刪除？"
            : "確定刪除這筆待繳紀錄？（保留稽核紀錄）";
          if (window.confirm(msg)) run(() => api.deletePayment(payment.id));
        }}
      >刪除此筆</button>
    </Modal>
  );
}
```

- [ ] **Step 3: Point `Payments.tsx` at the moved component**

Delete the whole `function PaymentDetail(...) { ... }` block from `packages/admin/src/views/Payments.tsx` and add the import below the existing ones (line 3-ish):

```tsx
import { PaymentDetail } from "./PaymentDetail";
```

Leave the `<PaymentDetail … />` usage untouched. Do not remove any other import: `Field`, `Money`, `StatusBadge`, `IconWarning`, `Modal` and `type ChannelTag` are all still used by the table, `SyncModal`, `ManualModal` and `LinkModal`.

- [ ] **Step 4: Verify the gates pass with no behavior change**

Run: `pnpm --filter @chippot/admin typecheck && pnpm --filter @chippot/admin build`
Expected: both PASS. If typecheck complains about an unused import in `Payments.tsx`, remove only that one symbol.

- [ ] **Step 5: Commit**

```bash
git add packages/admin/src/api.ts packages/admin/src/views/PaymentDetail.tsx packages/admin/src/views/Payments.tsx
git commit -m "refactor(admin): extract PaymentDetail into its own view; add payments filters + verifyAll to the API client"
```

---

### Task 6: `MemberReview` view + deep-link routing

**Files:**
- Create: `packages/admin/src/views/MemberReview.tsx`
- Modify: `packages/admin/src/views/Payments.tsx:13-19` (hash parsing), `:40-57` (deep-link effects), the member-name table cell, and add the member-mode early return
- Modify: `packages/admin/src/styles.css` (append the aggregate-review section)

**Interfaces:**
- Consumes: `api.payments({ user_id, period })`, `api.payments({ id })`, `api.verifyAll(userId, period)`, `api.verify(id, null)`, `api.reject(id, reason)` (Task 5); `PaymentDetail` from `./PaymentDetail`; `Payment.user_id` (Task 1).
- Produces:
  - `export function MemberReview({ userId, period, tags, onBack }: { userId: number; period: string; tags: ChannelTag[]; onBack: () => void })`
  - In `Payments.tsx`: `type DeepLink = { kind: "member"; userId: number; period: string } | { kind: "payment"; id: number }` and `function deepLinkFromHash(): DeepLink | null`.
  - CSS classes used by Task 7's mobile work: `.mreview__head`, `.mreview__title`, `.mreview__meta`, `.mreview__body`, `.mreview__note`, `.mreview__note--warn`, `.mreview__bulk`, `.mreview__ok`, `.mrow`, `.mrow__main`, `.mrow__top`, `.mrow__plan`, `.mrow__facts`, `.mrow__acts`, `.mrow__reject`, `.linkbtn`.

- [ ] **Step 1: Write the `MemberReview` view**

Create `packages/admin/src/views/MemberReview.tsx`:

```tsx
import { useState } from "react";
import { api, type ChannelTag, type Payment } from "../api";
import { useAsync, Card, Empty, Money, StatusBadge, IconCheck, IconWarning } from "../ui";
import { PaymentDetail } from "./PaymentDetail";

/**
 * Aggregate review for ONE member × ONE period — where a payment-submission notification lands
 * (#payments?user=<id>&period=<YYYY-MM>). One member submit settles one payment row per active
 * subscription, all sharing one screenshot, so this shows the screenshot once and lets the owner
 * approve the whole period with a single tap (一鍵全部核准); per-row 核准／退回 stay available for
 * the mixed cases. Laid out mobile-first: everything stacks, actions are thumb-sized.
 */
export function MemberReview({ userId, period, tags, onBack }: {
  userId: number; period: string; tags: ChannelTag[]; onBack: () => void;
}) {
  const list = useAsync(() => api.payments({ user_id: userId, period }), [userId, period]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<number | null>(null);
  const [reason, setReason] = useState("");
  const [selected, setSelected] = useState<Payment | null>(null);

  const rows = list.data?.payments ?? [];
  const name = rows[0]?.user_name ?? `#${userId}`;
  const reviewable = rows.filter((p) => p.status === "paid"); // 已繳待驗 — what 全部核准 covers
  const total = rows.reduce((s, p) => s + p.amount, 0);
  // One submit shares one screenshot key across every settled row — render each distinct proof once.
  const proofKeys = [...new Set(rows.filter((p) => p.has_proof && p.screenshot_key).map((p) => p.screenshot_key!))];
  const proofExpired = proofKeys.length === 0 && rows.some((p) => p.has_proof === 1 && p.proof_deleted_at);
  const notes = [...new Set(rows.map((p) => p.payment_note).filter((n): n is string => !!n))];

  async function run(fn: () => Promise<string | null>) {
    setBusy(true); setErr(null); setDone(null);
    try { setDone(await fn()); list.reload(); }
    catch (e) { setErr((e as Error).message); }
    setBusy(false);
  }

  return (
    <>
      <div className="toolbar">
        <button className="btn" onClick={onBack}>← 返回繳費列表</button>
      </div>
      {err && <div className="error-banner">{err}</div>}
      {list.error && <div className="error-banner">{list.error}</div>}

      <div className="mreview__head">
        <h2 className="mreview__title">{name}</h2>
        <span className="mreview__meta mono">{period}</span>
        {rows.length > 0 && <span className="mreview__meta">共 {rows.length} 筆 · 合計 <Money v={total} /></span>}
      </div>

      {list.loading && <Empty>載入中…</Empty>}
      {!list.loading && rows.length === 0 && <Empty>這位成員在 {period} 沒有繳費紀錄。</Empty>}

      {rows.length > 0 && (
        <>
          <Card title="繳費憑證">
            <div className="mreview__body">
              {proofKeys.map((k) => <img key={k} className="proof-img" src={api.imageUrl(k)} alt="繳費截圖" />)}
              {proofExpired && <p className="mreview__note">截圖已依保存期刪除（對帳資料保留）。</p>}
              {proofKeys.length === 0 && !proofExpired && (
                <p className="mreview__note mreview__note--warn"><IconWarning /> 無憑證，純聲明 — 請依備註與帳戶自行核對。</p>
              )}
              {notes.length > 0 && <p className="mreview__note">成員備註：{notes.join("；")}</p>}
            </div>
          </Card>

          <div className="mreview__bulk">
            <button
              className="btn btn--primary iconlbl"
              disabled={busy || reviewable.length === 0}
              onClick={() => run(async () => {
                const r = await api.verifyAll(userId, period);
                return `已核准 ${r.verified} 筆`;
              })}
            >
              <IconCheck />{busy ? "處理中…" : `一鍵全部核准（${reviewable.length} 筆）`}
            </button>
            {!busy && reviewable.length === 0 && <span className="mreview__meta">目前沒有待驗證的紀錄</span>}
            {done && <span className="mreview__ok"><IconCheck />{done}</span>}
          </div>

          <Card title="逐筆明細">
            {rows.map((p) => (
              <div className="mrow" key={p.id}>
                <div className="mrow__main">
                  <div className="mrow__top">
                    <span className="mrow__plan">{p.plan_name}</span>
                    <Money v={p.amount} />
                  </div>
                  <div className="mrow__facts">
                    <StatusBadge status={p.status} />
                    <span>申報渠道：{p.declared_channel_tag_name ?? "未指定"}</span>
                    <button className="linkbtn" onClick={() => setSelected(p)}>完整資訊</button>
                  </div>
                </div>
                <div className="mrow__acts">
                  {["pending", "paid", "rejected"].includes(p.status) && (
                    <button className="btn iconlbl" disabled={busy} title="標記已驗證（帶入申報渠道）"
                      onClick={() => run(async () => { await api.verify(p.id, null); return null; })}>
                      <IconCheck />核准
                    </button>
                  )}
                  {["pending", "paid"].includes(p.status) && (
                    <button className="btn btn--danger" disabled={busy}
                      onClick={() => { setRejecting(rejecting === p.id ? null : p.id); setReason(""); }}>退回</button>
                  )}
                </div>
                {rejecting === p.id && (
                  <div className="mrow__reject">
                    <input placeholder="退回原因（選填）" value={reason} disabled={busy}
                      onChange={(e) => setReason(e.target.value)} />
                    <button className="btn btn--danger" disabled={busy}
                      onClick={() => run(async () => { await api.reject(p.id, reason); setRejecting(null); setReason(""); return null; })}>確認退回</button>
                  </div>
                )}
              </div>
            ))}
          </Card>
        </>
      )}

      {selected && (
        <PaymentDetail
          payment={selected}
          tags={tags}
          onClose={() => setSelected(null)}
          onDone={() => { setSelected(null); list.reload(); }}
        />
      )}
    </>
  );
}
```

- [ ] **Step 2: Replace the hash parsing in `Payments.tsx`**

In `packages/admin/src/views/Payments.tsx`, replace `paymentIdFromHash` (lines 13-19) with:

```tsx
const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

type DeepLink =
  | { kind: "member"; userId: number; period: string }
  | { kind: "payment"; id: number };

/**
 * Where a payment-submission notification lands. Current shape: "#payments?user=42&period=2026-07"
 * — a member's whole period, because one submit settles several rows. Pushes already in the owner's
 * history carry the older "#payments?id=1042", which still opens that single payment's modal.
 */
function deepLinkFromHash(): DeepLink | null {
  const q = window.location.hash.split("?")[1];
  if (!q) return null;
  const params = new URLSearchParams(q);
  const userId = Number(params.get("user"));
  const period = params.get("period") ?? "";
  if (Number.isInteger(userId) && userId > 0 && PERIOD_RE.test(period)) return { kind: "member", userId, period };
  const id = Number(params.get("id"));
  if (Number.isInteger(id) && id > 0) return { kind: "payment", id };
  return null;
}
```

and add the import next to the others at the top:

```tsx
import { MemberReview } from "./MemberReview";
```

- [ ] **Step 3: Swap the deep-link effects and add the member-mode branch**

Replace the `deepId` block (lines 40-57) with:

```tsx
  const [deep, setDeep] = useState<DeepLink | null>(deepLinkFromHash);
  useEffect(() => {
    const onHash = () => setDeep(deepLinkFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  // Legacy single-payment link: fetch just that row (a filtered request — it may sit outside the
  // current period/status filters), open its review modal, then clean the query so a refresh
  // doesn't reopen it. The member × period form is handled by the branch below instead.
  useEffect(() => {
    if (deep?.kind !== "payment") return;
    let cancelled = false;
    api.payments({ id: deep.id }).then((r) => {
      if (cancelled) return;
      const p = r.payments[0];
      if (p) setSelected(p);
      setDeep(null);
      if (window.location.hash.includes("?")) history.replaceState(null, "", "#payments");
    }).catch(() => { if (!cancelled) setDeep(null); });
    return () => { cancelled = true; };
  }, [deep]);
```

Then add the member-mode early return **after every hook call and immediately before the component's main `return (`** (React requires the hooks above to run unconditionally):

```tsx
  // Aggregate review takes over the whole view — it IS the notification landing page. Leaving it
  // via 返回 rewrites the hash, which fires hashchange and drops us back to the list.
  if (deep?.kind === "member") {
    return (
      <MemberReview
        userId={deep.userId}
        period={deep.period}
        tags={tags.data?.channel_tags ?? []}
        onBack={() => { list.reload(); window.location.hash = "payments"; }}
      />
    );
  }

  return (
```

- [ ] **Step 4: Link the member name in the table to the aggregate review**

In the table body, replace the member cell (`<td>{p.user_name}</td>`) with a link that opens that member's period — the row's own `onClick` still opens the single-payment modal, so stop propagation:

```tsx
                  <td>
                    <button className="linkbtn" title="檢視這位成員本期的合併審核"
                      onClick={(e) => { e.stopPropagation(); window.location.hash = `payments?user=${p.user_id}&period=${p.period}`; }}>
                      {p.user_name}
                    </button>
                  </td>
```

- [ ] **Step 5: Append the aggregate-review styles**

Append to the end of `packages/admin/src/styles.css`:

```css
/* ── member × period aggregate review (payment-notification landing) ────────── */
/* Mobile-first: single column at any width; ≥721px the per-payment rows go two-column. */
.mreview__head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 12px; margin-bottom: 14px; }
.mreview__title { font-family: "Fraunces", serif; font-weight: 600; font-size: 20px; margin: 0; }
.mreview__meta { font-size: 13px; color: var(--muted); }
.mreview__body { padding: 14px 16px; }
.mreview__note { margin: 10px 0 0; font-size: 13px; color: var(--muted); line-height: 1.5; }
.mreview__note--warn { color: var(--amber); }
.mreview__ok { display: inline-flex; align-items: center; gap: 5px; font-size: 13px; color: var(--teal); }
/* the one action that matters on a phone: full-width and thumb-sized */
.mreview__bulk { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin-bottom: 18px; }
.mreview__bulk .btn { flex: 1 1 220px; min-height: 46px; justify-content: center; }

.mrow { display: grid; gap: 8px; padding: 13px 16px; border-bottom: 1px solid var(--line); }
.mrow:last-child { border-bottom: 0; }
.mrow__main { min-width: 0; display: grid; gap: 5px; }
.mrow__top { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; }
.mrow__plan { font-weight: 600; }
.mrow__facts { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; font-size: 13px; color: var(--muted); }
.mrow__acts { display: flex; flex-wrap: wrap; gap: 8px; }
.mrow__acts .btn { flex: 1 1 auto; min-height: 40px; }
.mrow__reject { grid-column: 1 / -1; display: flex; flex-wrap: wrap; gap: 8px; }
.mrow__reject input {
  flex: 1 1 180px; padding: 9px 11px; border: 1.5px solid var(--line); border-radius: 9px;
  font: inherit; font-size: 14px; background: #fffdf8; color: var(--ink);
}
.linkbtn {
  border: 0; background: transparent; padding: 0; font: inherit; color: var(--teal-ink);
  text-decoration: underline; text-underline-offset: 2px; cursor: pointer;
}
@media (min-width: 721px) {
  .mrow { grid-template-columns: minmax(0, 1fr) auto; align-items: center; }
  .mrow__acts { justify-content: flex-end; }
  .mreview__bulk .btn { flex: 0 0 auto; }
}
```

- [ ] **Step 6: Verify the gates**

Run: `pnpm --filter @chippot/admin typecheck && pnpm --filter @chippot/admin build`
Expected: both PASS.

- [ ] **Step 7: Verify the deep link by hand**

```bash
pnpm --filter @chippot/admin dev
```

The dev server has no API behind it, so `GET /api/admin/payments` fails — that is expected. Confirm only the routing and layout:
1. Open `http://localhost:5173/#payments?user=1&period=2026-07` → the aggregate view renders (title `#1`, the `期別`, an error banner from the failed fetch), NOT the payments table.
2. Click **← 返回繳費列表** → the hash becomes `#payments` and the table view renders.
3. Open `http://localhost:5173/#payments?id=42` → no aggregate view; the hash is cleaned back to `#payments`.
4. Open `http://localhost:5173/#payments?user=1&period=garbage` → falls through to the normal list (an invalid period must not open the review).

- [ ] **Step 8: Commit**

```bash
git add packages/admin/src/views/MemberReview.tsx packages/admin/src/views/Payments.tsx packages/admin/src/styles.css
git commit -m "feat(admin): 成員×期別合併審核（通知深層連結入口 + 一鍵全部核准）"
```

---

### Task 7: mobile — payments table becomes cards, review modal becomes a bottom sheet

**Files:**
- Modify: `packages/admin/src/views/Payments.tsx` (add `className="tbl-cards"` to the payments `<table>`; add `data-label` to each body `<td>`)
- Modify: `packages/admin/src/styles.css` (append the ≤720px block)

**Interfaces:**
- Consumes: the post-#29 table markup and the `.mreview__*` / `.mrow*` classes from Task 6.
- Produces: the `.tbl-cards` opt-in class. Nothing later depends on it.

Two scoping notes before you start:

- **`.tbl-cards` is opt-in on purpose.** The `table` / `th` / `td` rules in `styles.css:81-83` are global, and the Dashboard and Manage views use them. Scoping the stacked-card rules to `.tbl-cards` is what keeps this change to the payments table only.
- **`.modal` is one shared component** (`ui.tsx`'s `Modal`), so the bottom-sheet rule applies to every modal below 720px, not just `PaymentDetail`. That is deliberate — it is a strictly better mobile presentation for a component the spec asks us to fix, and it needs no prop plumbing. Task 9 includes an explicit 375px check of a non-payments modal to prove nothing regressed. Do **not** add `viewport-fit=cover` to `packages/admin/index.html`: without it iOS insets the viewport itself, so a fixed bottom sheet stays clear of the home indicator and the Settings `.savebar` keeps working untouched.

- [ ] **Step 1: Tag the payments table for card mode**

In `packages/admin/src/views/Payments.tsx`, add the class to the payments table only:

```tsx
          <table className="tbl-cards">
```

Then add a `data-label` to every body `<td>` — the label is the text of its column header, and the trailing action cell gets none. After PR #29 the row should end up looking like this (**keep whatever column set the rebased file has** — the `憑證` cell is conditional on R2 and the loading/empty rows keep #29's dynamic `colSpan`; only the `data-label` attributes and the member link are yours to add):

```tsx
                <tr key={p.id} className="click" onClick={() => setSelected(p)}>
                  <td data-label="成員">
                    <button className="linkbtn" title="檢視這位成員本期的合併審核"
                      onClick={(e) => { e.stopPropagation(); window.location.hash = `payments?user=${p.user_id}&period=${p.period}`; }}>
                      {p.user_name}
                    </button>
                  </td>
                  <td data-label="方案">{p.plan_name}</td>
                  <td data-label="期別" className="mono">{p.period}</td>
                  <td data-label="金額" className="right"><Money v={p.amount} /></td>
                  <td data-label="狀態"><StatusBadge status={p.status} /></td>
                  <td data-label="申報渠道">{p.declared_channel_tag_name ?? "—"}</td>
                  {/* 憑證 cell: rendered only when R2 is configured (PR #29) */}
                  <td data-label="憑證">{/* …#29's existing 有截圖／純聲明／— content, unchanged… */}</td>
                  <td className="right" onClick={(e) => e.stopPropagation()}>
                    {p.status === "paid" && <QuickVerify id={p.id} onDone={reload} />}
                  </td>
                </tr>
```

- [ ] **Step 2: Append the mobile block**

Append to the end of `packages/admin/src/styles.css`:

```css
/* ── ≤720px: payments review on a phone ─────────────────────────────────────── */
/* Rows stack into cards (labels come from each cell's data-label) instead of scrolling
   sideways, and modals sit as a bottom sheet. Scoped to .tbl-cards so the dashboard and
   manage tables keep their horizontal-scroll layout. */
@media (max-width: 720px) {
  .tbl-cards thead { display: none; }
  .tbl-cards, .tbl-cards tbody, .tbl-cards tr, .tbl-cards td { display: block; width: 100%; }
  .tbl-cards tr { padding: 12px 16px; border-bottom: 1px solid var(--line); }
  .tbl-cards tr:last-child { border-bottom: 0; }
  .tbl-cards td {
    border: 0; padding: 3px 0; white-space: normal; text-align: left;
    display: flex; align-items: baseline; justify-content: space-between; gap: 12px;
  }
  .tbl-cards td::before {
    content: attr(data-label); flex: 0 0 auto;
    font-size: 12px; letter-spacing: .5px; color: var(--muted);
  }
  .tbl-cards td:empty { display: none; } /* e.g. the action cell of a non-paid row */
  /* the member name reads as the card's title */
  .tbl-cards td:first-child { padding: 0 0 6px; font-size: 15.5px; font-weight: 600; }
  .tbl-cards td:first-child::before { display: none; }
  /* the trailing action cell gets one full-width, thumb-sized button */
  .tbl-cards td:last-child { padding-top: 9px; }
  .tbl-cards td:last-child .btn { width: 100%; min-height: 42px; justify-content: center; }

  /* review modal → bottom sheet: no wasted side padding, reachable actions */
  .modal__backdrop { padding: 0; place-items: end stretch; }
  .modal { max-width: none; max-height: 92dvh; border-radius: 16px 16px 0 0; }
  .modal__body { padding: 16px 16px 26px; }
  /* label above value — a two-column grid squeezes long channel names at 375px */
  .kv { grid-template-columns: minmax(0, 1fr); gap: 0; }
  .kv dt { margin-top: 9px; font-size: 12px; }
  .kv dt:first-of-type { margin-top: 0; }
  .modal__body .btn { min-height: 42px; }
}
```

- [ ] **Step 3: Verify the gates**

Run: `pnpm --filter @chippot/admin typecheck && pnpm --filter @chippot/admin build`
Expected: both PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/admin/src/views/Payments.tsx packages/admin/src/styles.css
git commit -m "fix(admin): 繳費審核在手機可用（表格改卡片列、審核彈窗改底部抽屜）"
```

---

### Task 8: sync the copy that describes the deep link

**Files:**
- Modify: `packages/admin/src/views/Settings.tsx:155` (notification preview sample)
- Modify: `README.md` (lines ~60-62, ~221-223, the review-queue bullet ~53-55, and the test badge on line 12)

**Interfaces:** none — documentation and one preview string.

- [ ] **Step 1: Fix the notification preview sample link**

The Settings → 繳費通知 preview shows admins what the push will look like, so it must show the real link shape. In `packages/admin/src/views/Settings.tsx`, line 155:

```tsx
  const notifySample = { payer: "廖清筆", amount: "1,258", period: currentPeriod(), admin_url: `${window.location.origin}/#payments?user=42&period=${currentPeriod()}` };
```

- [ ] **Step 2: Update the README prose**

Replace the 📲 feature bullet (README lines 60-62):

```markdown
- 📲 **Submission alerts** — when a member submits a payment, push the owner a Bark and/or webhook
  notice (Discord / Google Chat / Slack — body shape auto-detected by host) with a deep link
  straight to that member's period review — one submit settles every subscription, so the link
  opens all of them together with a 一鍵全部核准 button.
```

Replace the **Submission alerts** operations bullet (README lines 221-223):

```markdown
- **Submission alerts** — set a Bark URL and/or a webhook (Discord / Google Chat / Slack) under
  Settings → 繳費通知; each new submission then pushes you a notice that opens that member's whole
  period for review (shared screenshot once, every row listed, 一鍵全部核准), phone-friendly. Both
  are optional and best-effort (a slow or failing endpoint never blocks the payment).
```

And extend the **Review queue** bullet (README lines ~53-55) with one sentence after the existing text:

```markdown
  Tapping a member's name (or a submission alert) opens the **成員×期別合併審核**: the shared
  screenshot once, every settled row, and one 一鍵全部核准 button. The queue, that view and the
  review dialog all work on a phone.
```

- [ ] **Step 3: Update the test badge with the real number**

```bash
pnpm --filter @chippot/worker test 2>&1 | tail -5
```

Read the actual passing count from the output and put it in README line 12 (expected 259 = 243 + 4 + 5 + 6 + 1):

```markdown
![Vitest](https://img.shields.io/badge/tests-259%20passing-0f6e63?logo=vitest&logoColor=white)
```

- [ ] **Step 4: Commit**

```bash
git add README.md packages/admin/src/views/Settings.tsx
git commit -m "docs(readme): aggregate review + mobile payments; bump test badge"
```

---

### Task 9: full verification and PR

**Files:** none modified — this task only verifies and opens the PR.

**Interfaces:** none.

- [ ] **Step 1: Run every CI gate exactly as CI does**

```bash
pnpm -r typecheck
pnpm -r test
VITE_API_BASE=https://example.invalid pnpm -r build
```

Expected: all three PASS. `pnpm -r test` is the worker suite (259) — the admin and web packages have no `test` script. If any of these fail, fix it before continuing; do not open the PR on a red gate.

- [ ] **Step 2: Verify the phone layout at 375px**

```bash
pnpm --filter @chippot/admin dev
```

In the browser devtools device toolbar at **375 × 812**, check (the API is not running, so judge layout and routing, not data):
1. `#payments` — the toolbar wraps, and the table is **not** horizontally scrollable; each row is a stacked card whose first line is the member name (once data exists locally, or against a `wrangler dev` worker if you have one).
2. Nothing on the page scrolls sideways — the document's horizontal scrollbar must not appear.
3. `#payments?user=1&period=2026-07` — the aggregate view fits the width; the 一鍵全部核准 button is full-width and at least ~46px tall.
4. Open any modal (e.g. 手動補登 from the payments toolbar) — it sits as a bottom sheet, full width, rounded top corners, and its content scrolls inside the sheet.
5. Open a **non-payments** modal too (成員 → edit a member, or Settings → 匯入 CSV) — confirm the shared sheet styling looks right there as well and that Settings' sticky 儲存 bar is still fully visible.
6. Back at ≥1000px width: the payments table is a normal table again with the #29 column set, and the aggregate view's per-payment rows are two-column.

- [ ] **Step 3: Push and open the PR**

```bash
git push -u origin feat/27-26-aggregate-review-mobile
gh pr create --title "feat: 成員×期別合併審核 + 繳費審核手機化" --body "$(cat <<'EOF'
## 為什麼

一位成員一次繳費會結清 N 筆帳（每個訂閱一筆、共用同一張截圖），但通知只深連到第一筆，審核端也只有單筆 API — 一次繳費要點 N 次。同時後台表格在手機上只能左右滑，審核很痛苦。

## 做了什麼

**#27 合併審核**
- `POST /admin/payments/verify-all`（`{ user_id, period }`）一次核准該成員該期所有「已繳待驗」的帳；每筆各自帶入自己的「申報渠道」，與單筆核准行為一致，狀態機不變。`pending` / `rejected` 不會被掃進來（成員並未為那些帳送出繳費）。稽核：每筆一筆 `payment.verify`，外加一筆 `payment.verify_all` 摘要記在成員上。
- 通知深連結改為 `#payments?user=<id>&period=<YYYY-MM>`（成員×期別）。Bark / webhook 的格式不變。**舊的 `#payments?id=<paymentId>` 連結仍可用**（管理者手機上還留著舊推播）。
- 新增「成員×期別合併審核」畫面：共用截圖只顯示一次、逐筆列出（方案／金額／狀態／申報渠道）、一鍵全部核准，也可單筆核准／退回。表格中的成員名稱也能點進來。
- `GET /admin/payments` 新增 `user_id` 與 `id` 篩選；深連結改用篩選過的請求，不再抓全表在前端過濾。

**#26 手機化**
- 繳費表格在 ≤720px 改成堆疊卡片（`.tbl-cards` + `data-label`，只作用在繳費表，其他頁表格不動）。
- 審核彈窗在 ≤720px 改為底部抽屜、`.kv` 改為標籤在上，按鈕加大到可用的觸控尺寸。`Modal` 是共用元件，所以此樣式對所有彈窗生效（已在 375px 逐一確認過其他頁彈窗與設定頁儲存列）。
- 新的合併審核畫面本身即 mobile-first（375px 可用）。

## 驗證

- `pnpm -r typecheck` / `pnpm -r test`（259 passing）/ `pnpm -r build` 全綠。
- 新增測試：`test/routes/payments-review.test.ts`（篩選 + verify-all 的狀態碼、渠道帶入、稽核、跨成員/跨期不越界）、`test/core/payments-verify-all.test.ts`（狀態機邊界、跨工作區渠道處理、idempotent）、`payment-notify.test.ts`（連結新形狀 + 兩個訂閱只發一則通知）。
- 375px 手動確認：列表卡片化、無橫向溢出、合併審核與彈窗可用。

Closes #27
Closes #26
EOF
)"
```

- [ ] **Step 4: Confirm CI is green**

```bash
gh pr checks --watch
```

Expected: the `check` job passes. If it fails, fix on this branch and push again.

---

## Self-Review

**1. Spec coverage**

| Spec requirement | Task |
|---|---|
| #27.1 bulk-verify capability, own declared channel per row, respects state machine, audit | Tasks 2 (core + channel defaulting + state machine) and 3 (endpoint + `payment.verify` per row + `payment.verify_all` summary) |
| #27.2 deep link becomes member × period; `settleUserPeriod` passes what's needed; Bark + webhook formats intact; old `?id=` links keep working | Task 4 (link + `PaymentNotifyInput.userId` + `storage.ts` call site + both builders re-asserted by the existing tests) and Task 6 Step 2/3 (SPA still parses `?id=`) |
| #27.3 aggregate view: shared screenshot once, per-payment rows (plan, amount, status, declared channel), 一鍵全部核准, per-payment verify/reject | Task 6 Step 1 |
| #27.4 replace the unfiltered fetch with a filtered fetch; minimal API support | Task 1 (`user_id` + `id` filters) and Task 6 Step 3 (`api.payments({ id })`, `api.payments({ user_id, period })`) |
| #26.1 new view mobile-first, usable at 375px | Task 6 Step 5 (mobile-first CSS), Task 9 Step 2 (375px check) |
| #26.2 payments table + PaymentDetail modal usable ≤720px, card-style, plain CSS | Task 7 |
| #26.3 don't redesign other admin pages | Task 7 scoping notes (`.tbl-cards` opt-in; the shared-`Modal` decision stated and verified in Task 9 Step 2 item 5) |
| Coordination: written against #29's end state; rebase first | "Coordination" section, Task 1 Step 1 (guard `grep`), Task 7 Step 1 |
| Branch name; `Closes #27` + `Closes #26` | Task 1 Step 1, Task 9 Step 3 |
| 243 tests stay green; new backend tests in existing style | Every worker task ends on a suite run; Tasks 1-4 add tests modelled on `payment-crud.test.ts`, `payments-unverify.test.ts`, `payment-notify.test.ts` |
| No new frontend test infra; use existing gates | Tasks 5-7 gate on `typecheck` + `build` only |
| Never modify `wrangler.toml` | Global Constraints; no task touches it |

No gaps found.

**2. Placeholder scan**

Every code step carries real code. The one intentionally partial snippet is Task 7 Step 1's `憑證` cell, marked as PR #29's existing content — the instruction there is precise (add only `data-label`, keep #29's column set and dynamic `colSpan`), because that file's exact post-rebase text cannot be quoted before #29 merges. The Task 4 test edits are given as an exact old→new table rather than a re-paste of the whole 252-line test file. No "TBD", no "add error handling", no "similar to Task N".

**3. Type consistency**

- `verifyUserPeriod(db, VerifyUserPeriodOpts) → VerifyUserPeriodResult { verified: { before: PaymentRow; after: PaymentRow }[] }` — defined in Task 2, consumed in Task 3 as `v.before` / `v.after.id`. Matches.
- `POST /admin/payments/verify-all` body `{ user_id, period }` → `{ ok, verified, payment_ids }` — Task 3 handler, Task 3 tests, Task 5 `api.verifyAll`, Task 6 `r.verified`. Matches.
- `PaymentNotifyInput.userId` (Task 4) is the only new field; `paymentId` is removed and `storage.ts` is updated in the same task, so `pnpm typecheck` in Task 4 Step 5 catches any straggler.
- `Payment.user_id` added in Task 5, produced by the SQL in Task 1 (`s.user_id AS user_id`), consumed in Task 6 Step 4 / Task 7 Step 1 (`p.user_id`). Matches.
- `MemberReview({ userId, period, tags, onBack })` — Task 6 Step 1 definition and Task 6 Step 3 call site agree; `PaymentDetail({ payment, tags, onClose, onDone })` is unchanged from the moved original and is called identically from both `Payments.tsx` and `MemberReview.tsx`.
- CSS class names declared in Task 6 Step 5 (`.mreview__*`, `.mrow*`, `.linkbtn`) are exactly the ones used in Task 6 Step 1 and Task 7 Step 1 (`.linkbtn` in the table cell). `.tbl-cards` is introduced and styled in Task 7 only.
