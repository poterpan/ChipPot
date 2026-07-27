# CSV 匯入：FALSE 暫停訂閱 + 差異預覽 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the CSV roster import handle un-subscription (a plan cell that flipped TRUE→FALSE pauses that subscription) and show the admin a dry-run diff of everything the import would change before it is applied — closing issue #28.

**Architecture:** `importRoster` is rewritten into the same two-phase shape the reconcile action already uses (`reconcilePeriodBills` in `packages/worker/src/core/billing.ts`): a read-only compute pass resolves every CSV row into an internal per-member work item (`RowPlan`), then — only when `dryRun` is false — an apply pass writes it. Both passes return the *same* structured `ImportDiff`, so the preview and the applied result are literally the same shape. The endpoint `POST /admin/members/import` gains `dry_run` defaulting to **true** (the convention `POST /admin/billing/:period/sync` already uses), and the admin `ImportModal` becomes 選檔 → 預覽差異 → 確認套用.

**Tech Stack:** Cloudflare Workers + D1 (hand-rolled router, `packages/worker`), Vitest with `@cloudflare/vitest-pool-workers` (real Miniflare D1/R2, no mocks), React 18 + Vite SPA (`packages/admin`, plain CSS in `src/styles.css`, no Tailwind), pnpm workspace.

## Global Constraints

- **Branch:** `feat/28-import-pause-diff`. The PR body must contain `Closes #28`.
- **TDD, always:** write the failing test first, watch it fail, then implement. Worker tests are real-runtime (`import { env } from "cloudflare:test"`), never mocked.
- **Baseline to protect:** `pnpm --filter @chippot/worker test` is green today at **243 passed (38 files)**. It must be green (and larger) at the end of every task.
- **Storage isolation is per test FILE**, not per test (see the comment in `packages/worker/vitest.config.ts`): writes from one `it` persist into the next `it` in the same file. Every new DB fixture must use ids/emails that collide with nothing else in that file. New `describe` blocks get their own high-numbered workspace, mirroring `packages/worker/test/core/billing-reconcile.test.ts:64-83`.
- **`packages/worker/tsconfig.json` includes `test`**, so a type change to an exported interface breaks `pnpm typecheck` in the test files too. Each task must leave `pnpm -r typecheck` green — fix test fixtures in the same task that changes the type.
- **DO NOT MODIFY `packages/admin/src/views/Payments.tsx` AT ALL.** A parallel PR rewrites that file. You may *read* it for visual reference. Any component you want from it must be re-created in a new file — small duplication is explicitly accepted here; importing from `Payments.tsx` is forbidden. (`Stat` is fine to import: it lives in `packages/admin/src/ui.tsx:73`, not in `Payments.tsx`.)
- **NEVER modify `packages/worker/wrangler.toml`.** No new migrations are needed — this feature writes only `subscriptions.status`, whose CHECK constraint already allows `'paused'` (`packages/worker/migrations/0001_init.sql:61`).
- **Import must never modify or delete a payment/bill of a paused subscription.** `affected_pending_bills` is REPORT-ONLY; the UI points the admin at the existing 重新同步本期帳單 button instead.
- Public repo: no secrets, no real Discord/Bark IDs in code, tests, or docs.
- Admin package has no test runner: its gates are `pnpm --filter @chippot/admin typecheck` and `pnpm --filter @chippot/admin build` only.
- All user-facing copy is Traditional Chinese (zh-TW). Conventional-commit subjects; zh-TW in the subject is fine (see `git log`).
- YAGNI: no new abstractions beyond what the tasks below name.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `packages/worker/src/core/import.ts` | **Modify.** CSV parser gains explicit-FALSE tracking; `importRoster` becomes compute-then-apply and returns `ImportDiff`. | 1–4 |
| `packages/worker/test/core/import.test.ts` | **Modify.** Parser cases + one new `describe` per semantic slice, each in its own isolated workspace. | 1–4 |
| `packages/worker/src/routes/admin.ts` | **Modify** `membersImport` only (`:206-229`): parse `dry_run` from JSON *and* multipart, return `{ ok, diff }`, audit only on apply. | 5 |
| `packages/worker/test/routes/admin.test.ts` | **Modify.** Update the 3 existing import cases; add dry-run-default / apply+audit / multipart cases. | 5 |
| `packages/admin/src/api.ts` | **Modify.** `ImportDiff` + line types; `importMembers(file, { startDate, dryRun })`. | 6 |
| `packages/admin/src/components/DiffList.tsx` | **Create.** Collapsible diff list, duplicated from the reconcile modal's local one (see constraint). | 6 |
| `packages/admin/src/views/Settings.tsx` | **Modify** `ImportModal` only (`:303-330`): two-step 預覽 → 套用. | 7 |
| `README.md` | **Modify.** Test badge + the CSV-import highlight bullet. | 8 |

---

## Task 1: Parser records explicitly-FALSE plan cells

**Files:**
- Modify: `packages/worker/src/core/import.ts:5-34`
- Test: `packages/worker/test/core/import.test.ts:5-26` (and the row literals at `:44-48`, `:64`)

**Interfaces:**
- Produces: `RosterRow { name: string; email: string; plans: string[]; plansOff: string[] }` — `plans` = cells whose trimmed value uppercases to `"TRUE"`, `plansOff` = cells that uppercase to `"FALSE"`. Anything else (blank, `"1"`, garbage) lands in **neither** list, so it means "leave untouched".

- [ ] **Step 1: Write the failing test**

In `packages/worker/test/core/import.test.ts`, replace the whole `describe("parseRosterCsv", …)` block (currently `:12-26`) with:

```ts
describe("parseRosterCsv", () => {
  it("extracts name, email, TRUE plans and explicitly-FALSE plans (case-insensitive); skips blank lines", () => {
    const rows = parseRosterCsv(CSV);
    expect(rows.length).toBe(4);
    expect(rows[0]).toEqual({ name: "Alice", email: "alice@example.com", plans: ["ChatGPT", "Claude Premium"], plansOff: ["Claude Standard"] });
    expect(rows[1]).toEqual({ name: "Bob", email: "bob@example.com", plans: ["Claude Standard"], plansOff: ["ChatGPT", "Claude Premium"] });
    expect(rows[2]).toEqual({ name: "", email: "blank@example.com", plans: ["ChatGPT"], plansOff: ["Claude Standard", "Claude Premium"] });
    expect(rows[3]).toEqual({ name: "Carol", email: "carol@example.com", plans: ["ChatGPT"], plansOff: ["Claude Standard", "Claude Premium"] }); // lowercase true/false count
  });

  it("leaves blank and non-boolean cells out of BOTH lists (they mean 'untouched')", () => {
    const rows = parseRosterCsv("姓名,帳號,ChatGPT,Claude Standard,Claude Premium\nDana,dana@example.com,,1,FALSE");
    expect(rows[0]).toEqual({ name: "Dana", email: "dana@example.com", plans: [], plansOff: ["Claude Premium"] });
  });

  it("returns [] for empty or header-only input", () => {
    expect(parseRosterCsv("")).toEqual([]);
    expect(parseRosterCsv("姓名,帳號,ChatGPT")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @chippot/worker test -- import.test.ts`
Expected: FAIL — the three `toEqual` calls report a missing `plansOff` key (the parser doesn't produce it yet).

- [ ] **Step 3: Write minimal implementation**

In `packages/worker/src/core/import.ts`, replace lines 5-34 (the `RosterRow` interface, the doc comment, and `parseRosterCsv`) with:

```ts
export interface RosterRow {
  name: string;
  email: string;
  /** Plan columns whose cell is explicitly TRUE. */
  plans: string[];
  /** Plan columns whose cell is explicitly FALSE (an un-subscription). Blank/other = untouched. */
  plansOff: string[];
}

/** Split a simple CSV line on commas (the club roster has no quoted/embedded commas). */
function splitCsvLine(line: string): string[] {
  return line.split(",").map((c) => c.trim());
}

/**
 * Parse a Google-Forms roster CSV: header `姓名,帳號,<plan name…>`. A row subscribes to a plan
 * column when its cell is "TRUE" and un-subscribes when it is explicitly "FALSE" (both
 * case-insensitive). Any other value — including blank — is recorded in neither list and means
 * "don't touch this subscription". Blank lines are skipped.
 */
export function parseRosterCsv(text: string): RosterRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];
  const planCols = splitCsvLine(lines[0]!).slice(2);
  const rows: RosterRow[] = [];
  for (const line of lines.slice(1)) {
    const cells = splitCsvLine(line);
    const plans: string[] = [];
    const plansOff: string[] = [];
    planCols.forEach((col, idx) => {
      const v = (cells[idx + 2] ?? "").toUpperCase();
      if (v === "TRUE") plans.push(col);
      else if (v === "FALSE") plansOff.push(col);
    });
    rows.push({ name: cells[0] ?? "", email: cells[1] ?? "", plans, plansOff });
  }
  return rows;
}
```

- [ ] **Step 4: Fix the row literals the new required field breaks**

`RosterRow.plansOff` is required, so the hand-built rows in the `importRoster` tests no longer typecheck. In `packages/worker/test/core/import.test.ts`, update them:

```ts
    const rows = [
      { name: "Amy New", email: "amy@x.tw", plans: ["ChatGPT", "Claude Standard"], plansOff: [] },
      { name: "Ben", email: "ben@x.tw", plans: ["Claude Standard", "Gemini"], plansOff: [] },
      { name: "NoEmail", email: "", plans: ["ChatGPT"], plansOff: [] },
    ];
```

and in the idempotency test:

```ts
    const rows = [{ name: "Amy New", email: "amy@x.tw", plans: ["ChatGPT", "Claude Standard"], plansOff: [] }];
```

- [ ] **Step 5: Run tests + typecheck**

Run: `pnpm --filter @chippot/worker test && pnpm -r typecheck`
Expected: tests PASS (244 passed — 243 baseline + 1 new parser case), typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add packages/worker/src/core/import.ts packages/worker/test/core/import.test.ts
git commit -m "feat(import): 解析器記錄明確為 FALSE 的方案欄（plansOff）"
```

---

## Task 2: `importRoster` becomes compute-then-apply and returns `ImportDiff`

Same semantics as today (create/update members, add missing active subs, skip existing ones), but restructured: one read-only compute pass builds the diff, the apply pass only runs when `dryRun` is false. The pause / reactivate / conflict buckets exist and stay empty until Tasks 3–4 fill them.

**Files:**
- Modify: `packages/worker/src/core/import.ts:36-104` (`ImportOptions`, `ImportSummary` → `ImportDiff`, `importRoster`)
- Test: `packages/worker/test/core/import.test.ts` (rewrite the two `importRoster` cases; add a new isolated `describe`)

**Interfaces:**
- Consumes: `RosterRow { name, email, plans, plansOff }` from Task 1; `ensureFirstPayment(db, subscriptionId)` from `packages/worker/src/core/billing.ts:90`.
- Produces:
  - `ImportOptions { startDate: string; dryRun: boolean }` — `dryRun` is **required**, no default, so every caller states its intent.
  - `importRoster(env, workspaceId, rows, opts): Promise<ImportDiff>` (replaces `ImportSummary`).
  - `ImportDiff`, `ImportUserLine`, `ImportSubLine`, `ImportBillLine` exactly as written in Step 3 below. Task 5 (endpoint) and Task 6 (admin client types) both depend on these names.

- [ ] **Step 1: Write the failing tests**

In `packages/worker/test/core/import.test.ts`, replace the whole `describe("importRoster", …)` block (currently `:42-68`) with the following. The first two cases are the existing ones re-expressed in the new field names; the third and fourth are new.

```ts
describe("importRoster", () => {
  it("upserts by email (keeps discord_id), creates subs + first payments, reports unmatched plans", async () => {
    const rows = [
      { name: "Amy New", email: "amy@x.tw", plans: ["ChatGPT", "Claude Standard"], plansOff: [] },
      { name: "Ben", email: "ben@x.tw", plans: ["Claude Standard", "Gemini"], plansOff: [] },
      { name: "NoEmail", email: "", plans: ["ChatGPT"], plansOff: [] },
    ];
    const d = await importRoster(env, WS, rows, { startDate: "2026-06-01", dryRun: false });
    expect(d.dry_run).toBe(false);
    expect(d.period).toBe("2026-06");
    expect(d.users_created.map((u) => u.email)).toEqual(["ben@x.tw"]);
    expect(d.users_created[0]!.user_id).toBeGreaterThan(0); // filled in by the apply pass
    expect(d.users_updated).toBe(1);
    expect(d.subs_added.map((s) => s.plan_name).sort()).toEqual(["Claude Standard", "Claude Standard"]);
    expect(d.subs_added.every((s) => s.subscription_id !== null)).toBe(true);
    expect(d.subs_skipped).toBe(1);   // Amy already has an active ChatGPT sub
    expect(d.rows_skipped).toBe(1);   // the row with no email
    expect(d.unmatched_plans).toEqual(["Gemini"]);
    expect(d.subs_paused).toEqual([]);
    expect(d.subs_reactivated).toEqual([]);
    expect(d.cancelled_conflicts).toEqual([]);
    expect(d.affected_pending_bills).toEqual([]);

    const amy = await env.DB.prepare("SELECT display_name, discord_id FROM users WHERE email='amy@x.tw'").first<{ display_name: string; discord_id: string }>();
    expect(amy).toMatchObject({ display_name: "Amy New", discord_id: "disc-amy" });

    const ben = await env.DB.prepare("SELECT id FROM users WHERE email='ben@x.tw'").first<{ id: number }>();
    const pay = await env.DB.prepare(
      `SELECT p.status FROM payments p JOIN subscriptions s ON s.id=p.subscription_id WHERE s.user_id=? AND p.period='2026-06'`
    ).bind(ben!.id).first<{ status: string }>();
    expect(pay?.status).toBe("pending");
  });

  it("is idempotent on a re-run (no new users/subs)", async () => {
    const rows = [{ name: "Amy New", email: "amy@x.tw", plans: ["ChatGPT", "Claude Standard"], plansOff: [] }];
    const d = await importRoster(env, WS, rows, { startDate: "2026-06-01", dryRun: false });
    expect(d.users_created).toEqual([]);
    expect(d.users_updated).toBe(1);
    expect(d.subs_added).toEqual([]);
    expect(d.subs_skipped).toBe(2);
  });

  it("merges duplicate rows for the same email into one member (no double insert)", async () => {
    const rows = [
      { name: "", email: "dupe@x.tw", plans: ["ChatGPT"], plansOff: [] },
      { name: "Dupe Later", email: "dupe@x.tw", plans: ["ChatGPT", "Claude Standard"], plansOff: [] },
    ];
    const d = await importRoster(env, WS, rows, { startDate: "2026-06-01", dryRun: false });
    expect(d.users_created.length).toBe(1);
    expect(d.subs_added.map((s) => s.plan_name).sort()).toEqual(["ChatGPT", "Claude Standard"]);
    const n = await env.DB.prepare("SELECT COUNT(*) c FROM users WHERE workspace_id=? AND email='dupe@x.tw'").bind(WS).first<{ c: number }>();
    expect(n?.c).toBe(1);
    const u = await env.DB.prepare("SELECT id, display_name FROM users WHERE workspace_id=? AND email='dupe@x.tw'").bind(WS).first<{ id: number; display_name: string }>();
    expect(u!.display_name).toBe("Dupe Later"); // the last non-empty name in the CSV wins
    const subs = await env.DB.prepare("SELECT COUNT(*) c FROM subscriptions WHERE workspace_id=? AND user_id=?").bind(WS, u!.id).first<{ c: number }>();
    expect(subs?.c).toBe(2);
  });
});

// dryRun must compute exactly the same diff while writing nothing. Own workspace: storage is
// isolated per FILE, so this fixture must not collide with the WS=9028 rows above.
describe("importRoster dryRun", () => {
  const W = 9029, PL = 9029;
  beforeAll(async () => {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO workspaces (id,name,owner_id,channel_type,billing_day,settings,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(W, "W", "o", "discord", 5, "{}", TS, TS),
      env.DB.prepare(`INSERT INTO plans (id,workspace_id,name,provider,monthly_amount,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`).bind(PL, W, "ChatGPT", "openai", 315, TS, TS),
      env.DB.prepare(`INSERT INTO users (id,workspace_id,display_name,email,created_at,updated_at) VALUES (?,?,?,?,?,?)`).bind(W, W, "Old", "old@x.tw", TS, TS),
    ]);
  });

  it("reports what it would do and writes nothing", async () => {
    const rows = [
      { name: "Old Renamed", email: "old@x.tw", plans: ["ChatGPT"], plansOff: [] },
      { name: "Fresh", email: "fresh@x.tw", plans: ["ChatGPT"], plansOff: [] },
    ];
    const d = await importRoster(env, W, rows, { startDate: "2026-06-01", dryRun: true });
    expect(d.dry_run).toBe(true);
    expect(d.users_created).toEqual([{ user_id: null, user_name: "Fresh", email: "fresh@x.tw" }]);
    expect(d.users_updated).toBe(1);
    expect(d.subs_added.length).toBe(2);
    expect(d.subs_added.every((s) => s.subscription_id === null)).toBe(true);
    expect(d.subs_added[0]).toMatchObject({ plan_id: PL, plan_name: "ChatGPT", amount: 315 });

    const users = await env.DB.prepare("SELECT COUNT(*) c FROM users WHERE workspace_id=?").bind(W).first<{ c: number }>();
    expect(users?.c).toBe(1);                 // "Fresh" was NOT inserted
    const name = await env.DB.prepare("SELECT display_name FROM users WHERE id=?").bind(W).first<{ display_name: string }>();
    expect(name?.display_name).toBe("Old");   // the rename was NOT written
    const subs = await env.DB.prepare("SELECT COUNT(*) c FROM subscriptions WHERE workspace_id=?").bind(W).first<{ c: number }>();
    expect(subs?.c).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @chippot/worker test -- import.test.ts`
Expected: FAIL — `dryRun` is not a valid `ImportOptions` property and the returned object has `usersCreated`, not `users_created`.

- [ ] **Step 3: Write the implementation**

In `packages/worker/src/core/import.ts`, replace everything from line 36 (`export interface ImportOptions`) to the end of the file with:

```ts
export interface ImportOptions {
  startDate: string; // YYYY-MM-DD; new subscriptions' start (drives the first payment's period)
  dryRun: boolean;   // true = compute the diff and write nothing
}

export interface ImportUserLine {
  user_id: number | null; // null in a dry run (the row doesn't exist yet)
  user_name: string;
  email: string;
}
export interface ImportSubLine {
  subscription_id: number | null; // null for a sub that doesn't exist yet (dry run / to-be-added)
  user_id: number | null;
  user_name: string;
  email: string;
  plan_id: number;
  plan_name: string;
  amount: number; // the plan's current monthly_amount, for display only
}
export interface ImportBillLine {
  payment_id: number;
  subscription_id: number;
  user_name: string;
  plan_name: string;
  period: string;
  amount: number;
  status: string; // 'pending' | 'rejected'
}

/**
 * What an import did (apply) or would do (dry run) — the same shape either way, mirroring
 * ReconcileDiff in core/billing.ts. Counts are used for the audit entry; the line arrays feed
 * the admin's diff preview.
 */
export interface ImportDiff {
  dry_run: boolean;
  period: string; // the YYYY-MM the import bills into (derived from startDate)
  users_created: ImportUserLine[];
  users_updated: number; // members matched by email (their display_name is re-synced)
  subs_added: ImportSubLine[];
  subs_reactivated: ImportSubLine[];
  subs_paused: ImportSubLine[];
  cancelled_conflicts: ImportSubLine[];
  subs_skipped: number; // TRUE for a sub that is already active
  rows_skipped: number; // CSV rows with no email
  unmatched_plans: string[];
  /** REPORT-ONLY: this period's still-unpaid bills of the subs being paused. Import never
   *  touches payments here — the admin clears them with 重新同步本期帳單. */
  affected_pending_bills: ImportBillLine[];
}

interface PlanRef { id: number; name: string; amount: number }

/** One member's resolved work, keyed by email. Built read-only, then executed by the apply pass. */
interface RowPlan {
  email: string;
  name: string;
  existed: boolean;           // matched an existing user by email
  userId: number | null;      // null until the apply pass inserts the user
  trueSeen: Set<number>;      // plan ids this member had a TRUE for anywhere in the CSV
  add: PlanRef[];
  addedIds: Map<number, number>; // plan id → new subscription id (apply pass only)
  reactivate: { subId: number; plan: PlanRef }[];
  pause: { subId: number; plan: PlanRef }[];
  conflicts: { subId: number; plan: PlanRef }[];
}

/**
 * Upsert a roster and return the diff. Two passes, like reconcilePeriodBills:
 *
 *  1. compute (read-only): match users by email, read ALL of each member's subscriptions (every
 *     status), then classify each plan cell —
 *       TRUE  + active sub      → skipped
 *       TRUE  + paused sub      → reactivate (status back to 'active'; no payment row is written,
 *                                see below)
 *       TRUE  + cancelled sub   → cancelled_conflicts (cancelling is a deliberate manual act, so
 *                                never auto-revive it) and NO insert — that is what stops the old
 *                                "else INSERT" path from creating a duplicate subscription
 *       TRUE  + no sub          → add (new active sub + ensureFirstPayment)
 *       FALSE + active sub      → pause
 *       FALSE + anything else   → untouched
 *     Plan columns that match no ACTIVE plan land in unmatched_plans (TRUE or FALSE alike);
 *     columns absent from the CSV header are never even considered.
 *  2. apply (skipped entirely when opts.dryRun): insert/update users, then insert/reactivate/pause
 *     subscriptions.
 *
 * Reactivation deliberately writes NO payment row: ensureFirstPayment bills the subscription's
 * ORIGINAL start_date month, which for a months-old paused sub would open a bill in a closed past
 * period. The current period's bill is exactly what 重新同步本期帳單 (reconcilePeriodBills) creates
 * for every active sub that lacks one — and only for periods that are actually open. Pausing is the
 * mirror image: the stale bills are reported in affected_pending_bills and removed by that same
 * action. So the whole period-bill story stays in one place.
 *
 * Concurrency: the user/sub dedup is SELECT-then-INSERT, so two simultaneous imports of the same
 * roster could double-insert. This is a single-admin, occasional tool and the admin UI disables the
 * buttons while a request is in flight, so we don't enforce uniqueness at the DB. Re-running after
 * any failure is idempotent.
 */
export async function importRoster(
  env: Env,
  workspaceId: number,
  rows: RosterRow[],
  opts: ImportOptions
): Promise<ImportDiff> {
  const now = nowUtcIso();
  const period = opts.startDate.slice(0, 7);
  const wsRow = await env.DB.prepare("SELECT billing_day FROM workspaces WHERE id = ?").bind(workspaceId).first<{ billing_day: number }>();
  const billingDay = wsRow?.billing_day ?? 5;
  const plans = await env.DB.prepare("SELECT id, name, monthly_amount FROM plans WHERE workspace_id = ? AND active = 1")
    .bind(workspaceId).all<{ id: number; name: string; monthly_amount: number }>();
  const planByName = new Map<string, PlanRef>(plans.results.map((p) => [p.name, { id: p.id, name: p.name, amount: p.monthly_amount }]));

  const unmatched = new Set<string>();
  const byEmail = new Map<string, RowPlan>();
  const items: RowPlan[] = [];
  let subsSkipped = 0, rowsSkipped = 0;

  // ── Pass 1: compute (no writes) ────────────────────────────────────────────
  for (const row of rows) {
    if (!row.email) { rowsSkipped++; continue; }

    // Two CSV rows can carry the same email; merge them into ONE member so the apply pass can't
    // insert the same person twice (the old row-by-row code got this right only by accident,
    // because it inserted before reading the next row).
    let rp = byEmail.get(row.email);
    if (!rp) {
      const existing = await env.DB.prepare("SELECT id FROM users WHERE workspace_id = ? AND email = ?")
        .bind(workspaceId, row.email).first<{ id: number }>();
      rp = {
        email: row.email, name: row.name, existed: !!existing, userId: existing?.id ?? null,
        trueSeen: new Set(), add: [], addedIds: new Map(), reactivate: [], pause: [], conflicts: [],
      };
      byEmail.set(row.email, rp);
      items.push(rp);
    } else if (row.name) {
      rp.name = row.name; // last non-empty name wins, matching the old UPDATE-per-row behavior
    }

    // Every status, in one read: reading only 'active' subs is what let a TRUE cell insert a
    // duplicate next to a paused/cancelled sub.
    const subs = rp.userId == null ? [] : (await env.DB.prepare(
      "SELECT id, plan_id, status FROM subscriptions WHERE workspace_id = ? AND user_id = ? ORDER BY id"
    ).bind(workspaceId, rp.userId).all<{ id: number; plan_id: number; status: string }>()).results;
    const byPlan = new Map<number, { id: number; status: string }[]>();
    for (const s of subs) {
      const list = byPlan.get(s.plan_id) ?? [];
      list.push({ id: s.id, status: s.status });
      byPlan.set(s.plan_id, list);
    }

    for (const planName of row.plans) {
      const plan = planByName.get(planName);
      if (!plan) { unmatched.add(planName); continue; }
      if (rp.trueSeen.has(plan.id)) continue; // duplicate column/row for the same plan
      rp.trueSeen.add(plan.id);
      const mine = byPlan.get(plan.id) ?? [];
      if (mine.some((s) => s.status === "active")) { subsSkipped++; continue; }
      const paused = mine.filter((s) => s.status === "paused");
      if (paused.length) { rp.reactivate.push({ subId: paused[paused.length - 1]!.id, plan }); continue; }
      const cancelled = mine.filter((s) => s.status === "cancelled");
      if (cancelled.length) { rp.conflicts.push({ subId: cancelled[cancelled.length - 1]!.id, plan }); continue; }
      rp.add.push(plan);
    }

    for (const planName of row.plansOff) {
      const plan = planByName.get(planName);
      if (!plan) { unmatched.add(planName); continue; }
      for (const s of byPlan.get(plan.id) ?? []) {
        if (s.status !== "active") continue;                    // only an active sub can be paused
        if (rp.pause.some((x) => x.subId === s.id)) continue;    // duplicate column/row
        rp.pause.push({ subId: s.id, plan });
      }
    }
  }
  // A TRUE anywhere in the CSV for the same member+plan wins over a FALSE (contradictory duplicate rows).
  for (const rp of items) rp.pause = rp.pause.filter((x) => !rp.trueSeen.has(x.plan.id));

  const bills = await loadAffectedBills(env, workspaceId, period, items.flatMap((r) => r.pause.map((p) => p.subId)));

  // ── Pass 2: apply ─────────────────────────────────────────────────────────
  if (!opts.dryRun) {
    for (const rp of items) {
      if (rp.userId == null) {
        const res = await env.DB.prepare("INSERT INTO users (workspace_id, display_name, email, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
          .bind(workspaceId, rp.name, rp.email, now, now).run();
        rp.userId = res.meta.last_row_id as number;
      } else {
        await env.DB.prepare("UPDATE users SET display_name = ?, updated_at = ? WHERE id = ?")
          .bind(rp.name, now, rp.userId).run();
      }
      for (const plan of rp.add) {
        const ins = await env.DB.prepare(
          "INSERT INTO subscriptions (workspace_id, user_id, plan_id, start_date, billing_day, custom_cycle, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, 'active', ?, ?)"
        ).bind(workspaceId, rp.userId, plan.id, opts.startDate, billingDay, now, now).run();
        const subId = ins.meta.last_row_id as number;
        rp.addedIds.set(plan.id, subId);
        await ensureFirstPayment(env.DB, subId);
      }
      // Re-assert the expected status in the WHERE so a concurrent admin edit isn't clobbered.
      for (const r of rp.reactivate) {
        await env.DB.prepare("UPDATE subscriptions SET status = 'active', updated_at = ? WHERE id = ? AND status = 'paused'")
          .bind(now, r.subId).run();
      }
      for (const p of rp.pause) {
        await env.DB.prepare("UPDATE subscriptions SET status = 'paused', updated_at = ? WHERE id = ? AND status = 'active'")
          .bind(now, p.subId).run();
      }
    }
  }

  const line = (rp: RowPlan, plan: PlanRef, subId: number | null): ImportSubLine => ({
    subscription_id: subId, user_id: rp.userId, user_name: rp.name, email: rp.email,
    plan_id: plan.id, plan_name: plan.name, amount: plan.amount,
  });
  return {
    dry_run: opts.dryRun,
    period,
    users_created: items.filter((r) => !r.existed).map((r) => ({ user_id: r.userId, user_name: r.name, email: r.email })),
    users_updated: items.filter((r) => r.existed).length,
    subs_added: items.flatMap((r) => r.add.map((p) => line(r, p, r.addedIds.get(p.id) ?? null))),
    subs_reactivated: items.flatMap((r) => r.reactivate.map((x) => line(r, x.plan, x.subId))),
    subs_paused: items.flatMap((r) => r.pause.map((x) => line(r, x.plan, x.subId))),
    cancelled_conflicts: items.flatMap((r) => r.conflicts.map((x) => line(r, x.plan, x.subId))),
    subs_skipped: subsSkipped,
    rows_skipped: rowsSkipped,
    unmatched_plans: [...unmatched],
    affected_pending_bills: bills,
  };
}

/**
 * REPORT-ONLY: the period's still-unpaid (pending/rejected) bills of the subscriptions this import
 * is about to pause. Import never writes to payments — pausing a sub leaves its bills exactly where
 * they are, and the admin clears them with 重新同步本期帳單 (reconcilePeriodBills), which already
 * knows how to delete a non-active sub's unpaid bill plus its R2 proof and upload token. Bills from
 * OLDER periods are deliberately not listed: they are real unpaid debt, not a stale bill.
 */
async function loadAffectedBills(
  env: Env,
  workspaceId: number,
  period: string,
  subIds: number[]
): Promise<ImportBillLine[]> {
  if (subIds.length === 0) return [];
  const marks = subIds.map(() => "?").join(",");
  const res = await env.DB.prepare(
    `SELECT p.id AS payment_id, p.subscription_id AS subscription_id, p.amount AS amount, p.status AS status,
            u.display_name AS user_name, pl.name AS plan_name
     FROM payments p JOIN subscriptions s ON s.id = p.subscription_id
     JOIN users u ON u.id = s.user_id JOIN plans pl ON pl.id = s.plan_id
     WHERE p.workspace_id = ? AND p.period = ? AND p.status IN ('pending','rejected')
       AND p.subscription_id IN (${marks})
     ORDER BY p.id`
  ).bind(workspaceId, period, ...subIds)
    .all<{ payment_id: number; subscription_id: number; amount: number; status: string; user_name: string; plan_name: string }>();
  return res.results.map((b) => ({ ...b, period }));
}
```

Note: `loadAffectedBills` is called unconditionally in Task 2 and returns `[]` while nothing is ever paused; Tasks 3–4 exercise it for real.

- [ ] **Step 4: Fix the one remaining caller so typecheck passes**

`packages/worker/src/routes/admin.ts:226` still calls the old signature. Change that single line to keep today's endpoint behavior (Task 5 rewrites the handler properly):

```ts
  const diff = await importRoster(env, ws, parseRosterCsv(csv), { startDate: start, dryRun: false });
  await writeAudit(env.DB, { workspaceId: ws, actor: actorOf(ctx), action: "roster.import", entityType: "workspace", entityId: ws, after: diff });
  return json({ ok: true, summary: diff });
```

- [ ] **Step 5: Run tests + typecheck**

Run: `pnpm --filter @chippot/worker test && pnpm -r typecheck`
Expected: tests PASS (246 passed — 244 + the duplicate-email case + the dryRun case), typecheck clean. The route test `imports a CSV (JSON body) and returns a summary` still passes: it only asserts `body.summary` matches `{ usersCreated: 1, subsCreated: 1 }`… **it will FAIL**, because the summary is now the new shape. Fix it in this task by rewriting that one assertion:

```ts
    expect(body.summary.users_created.length).toBe(1);
    expect(body.summary.subs_added.length).toBe(1);
```

Re-run both commands and confirm green before committing.

- [ ] **Step 6: Commit**

```bash
git add packages/worker/src/core/import.ts packages/worker/test/core/import.test.ts packages/worker/src/routes/admin.ts packages/worker/test/routes/admin.test.ts
git commit -m "refactor(import): importRoster 改為先算後寫，回傳 ImportDiff（含 dryRun）"
```

---

## Task 3: A FALSE cell pauses that member's active subscription (bills reported, never touched)

**Files:**
- Modify: `packages/worker/src/core/import.ts` — nothing! The pause path was written in Task 2; this task proves it and is where any bug in it gets fixed.
- Test: `packages/worker/test/core/import.test.ts` (new `describe`, new isolated workspace `9030`)

**Interfaces:**
- Consumes: `importRoster(env, ws, rows, { startDate, dryRun })` → `ImportDiff` with `subs_paused: ImportSubLine[]` and `affected_pending_bills: ImportBillLine[]`, from Task 2.

- [ ] **Step 1: Write the failing tests**

Append to `packages/worker/test/core/import.test.ts`:

```ts
// FALSE = un-subscribe → pause (reversible; the owner chose paused over cancelled). Own workspace:
// storage is isolated per FILE, so ids/emails must not collide with the blocks above.
describe("importRoster FALSE pauses an active subscription", () => {
  const W = 9030, PL_A = 9030, PL_B = 90301;
  const U = 9030, S_ACTIVE = 9030, S_KEEP = 90301, P = "2026-06";
  beforeAll(async () => {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO workspaces (id,name,owner_id,channel_type,billing_day,settings,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(W, "W", "o", "discord", 5, "{}", TS, TS),
      env.DB.prepare(`INSERT INTO plans (id,workspace_id,name,provider,monthly_amount,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`).bind(PL_A, W, "ChatGPT", "openai", 315, TS, TS),
      env.DB.prepare(`INSERT INTO plans (id,workspace_id,name,provider,monthly_amount,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`).bind(PL_B, W, "Claude Standard", "anthropic", 251, TS, TS),
      env.DB.prepare(`INSERT INTO users (id,workspace_id,display_name,email,created_at,updated_at) VALUES (?,?,?,?,?,?)`).bind(U, W, "退訂者", "off@x.tw", TS, TS),
      env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`).bind(S_ACTIVE, W, U, PL_A, "2026-01-01", 5, "active", TS, TS),
      env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`).bind(S_KEEP, W, U, PL_B, "2026-01-01", 5, "active", TS, TS),
      env.DB.prepare(`INSERT INTO payments (id,workspace_id,subscription_id,period,period_start,period_end,due_date,amount,status,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).bind(90300, W, S_ACTIVE, P, `${P}-01`, `${P}-30`, `${P}-05`, 315, "pending", "cron", TS, TS),
      env.DB.prepare(`INSERT INTO payments (id,workspace_id,subscription_id,period,period_start,period_end,due_date,amount,status,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).bind(90301, W, S_KEEP, P, `${P}-01`, `${P}-30`, `${P}-05`, 251, "pending", "cron", TS, TS),
    ]);
  });

  // FALSE on ChatGPT, nothing at all for Claude Standard (absent from the header → untouched).
  const rows = () => [{ name: "退訂者", email: "off@x.tw", plans: [], plansOff: ["ChatGPT"] }];

  it("dry run reports the pause + this period's unpaid bill, and writes nothing", async () => {
    const d = await importRoster(env, W, rows(), { startDate: `${P}-01`, dryRun: true });
    expect(d.subs_paused.map((s) => s.subscription_id)).toEqual([S_ACTIVE]);
    expect(d.subs_paused[0]).toMatchObject({ user_name: "退訂者", plan_name: "ChatGPT", amount: 315 });
    expect(d.affected_pending_bills).toEqual([
      { payment_id: 90300, subscription_id: S_ACTIVE, user_name: "退訂者", plan_name: "ChatGPT", period: P, amount: 315, status: "pending" },
    ]);
    const s = await env.DB.prepare("SELECT status FROM subscriptions WHERE id=?").bind(S_ACTIVE).first<{ status: string }>();
    expect(s?.status).toBe("active"); // dry run wrote nothing
  });

  it("apply pauses only the FALSE sub, leaves every payment row untouched", async () => {
    const d = await importRoster(env, W, rows(), { startDate: `${P}-01`, dryRun: false });
    expect(d.subs_paused.map((s) => s.subscription_id)).toEqual([S_ACTIVE]);
    expect(d.affected_pending_bills.map((b) => b.payment_id)).toEqual([90300]);

    const a = await env.DB.prepare("SELECT status FROM subscriptions WHERE id=?").bind(S_ACTIVE).first<{ status: string }>();
    expect(a?.status).toBe("paused");
    const keep = await env.DB.prepare("SELECT status FROM subscriptions WHERE id=?").bind(S_KEEP).first<{ status: string }>();
    expect(keep?.status).toBe("active"); // plan column absent from the CSV header → never touched

    // Report-only: the paused sub's bill is still exactly where it was.
    const bills = (await env.DB.prepare("SELECT id, status, amount FROM payments WHERE workspace_id=? AND period=? ORDER BY id").bind(W, P).all<{ id: number; status: string; amount: number }>()).results;
    expect(bills.map((b) => b.id)).toEqual([90300, 90301]);
    expect(bills[0]).toMatchObject({ status: "pending", amount: 315 });
  });

  it("a paused sub is not re-paused and reports no bills on a re-run", async () => {
    const d = await importRoster(env, W, rows(), { startDate: `${P}-01`, dryRun: false });
    expect(d.subs_paused).toEqual([]);
    expect(d.affected_pending_bills).toEqual([]);
  });

  it("a FALSE column whose plan name matches nothing is reported as unmatched", async () => {
    const d = await importRoster(env, W, [{ name: "退訂者", email: "off@x.tw", plans: [], plansOff: ["Gemini"] }], { startDate: `${P}-01`, dryRun: true });
    expect(d.unmatched_plans).toEqual(["Gemini"]);
    expect(d.subs_paused).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests**

Run: `pnpm --filter @chippot/worker test -- import.test.ts`
Expected: PASS — the pause path from Task 2 already satisfies these. If any case fails, fix `importRoster`'s FALSE branch (or `loadAffectedBills`) until it passes; do not weaken the assertions.

- [ ] **Step 3: Run the full suite + typecheck**

Run: `pnpm --filter @chippot/worker test && pnpm -r typecheck`
Expected: 250 passed (246 + 4 new cases), typecheck clean.

- [ ] **Step 4: Commit**

```bash
git add packages/worker/test/core/import.test.ts packages/worker/src/core/import.ts
git commit -m "test(import): CSV FALSE 將訂閱轉為 paused，帳單只回報不變更"
```

---

## Task 4: TRUE on a paused sub reactivates it; TRUE on a cancelled sub is a conflict (no duplicate)

**Files:**
- Modify: `packages/worker/src/core/import.ts` — again nothing expected; these paths were written in Task 2 and this task proves them.
- Test: `packages/worker/test/core/import.test.ts` (new `describe`, new isolated workspace `9031`)

**Interfaces:**
- Consumes: `ImportDiff.subs_reactivated` / `ImportDiff.cancelled_conflicts` (`ImportSubLine[]`) from Task 2.

- [ ] **Step 1: Write the failing tests**

Append to `packages/worker/test/core/import.test.ts`:

```ts
// The reverse path: TRUE next to a non-active sub. paused → reactivate; cancelled → conflict only
// (cancelling is a deliberate manual act) and, critically, NO duplicate subscription is inserted.
describe("importRoster TRUE on paused / cancelled subscriptions", () => {
  const W = 9031, PL = 9031;
  const U_PAUSED = 9031, U_CANCEL = 90311;
  const S_PAUSED = 9031, S_CANCEL = 90311, P = "2026-06";
  beforeAll(async () => {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO workspaces (id,name,owner_id,channel_type,billing_day,settings,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(W, "W", "o", "discord", 5, "{}", TS, TS),
      env.DB.prepare(`INSERT INTO plans (id,workspace_id,name,provider,monthly_amount,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`).bind(PL, W, "ChatGPT", "openai", 315, TS, TS),
      env.DB.prepare(`INSERT INTO users (id,workspace_id,display_name,email,created_at,updated_at) VALUES (?,?,?,?,?,?)`).bind(U_PAUSED, W, "回來了", "back@x.tw", TS, TS),
      env.DB.prepare(`INSERT INTO users (id,workspace_id,display_name,email,created_at,updated_at) VALUES (?,?,?,?,?,?)`).bind(U_CANCEL, W, "已取消", "gone@x.tw", TS, TS),
      // start_date is months before the import period on purpose: it proves reactivation does NOT
      // call ensureFirstPayment (which would bill 2026-01, a long-closed period).
      env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`).bind(S_PAUSED, W, U_PAUSED, PL, "2026-01-01", 5, "paused", TS, TS),
      env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`).bind(S_CANCEL, W, U_CANCEL, PL, "2026-01-01", 5, "cancelled", TS, TS),
    ]);
  });

  const rows = () => [
    { name: "回來了", email: "back@x.tw", plans: ["ChatGPT"], plansOff: [] },
    { name: "已取消", email: "gone@x.tw", plans: ["ChatGPT"], plansOff: [] },
  ];

  it("dry run reports one reactivation + one cancelled conflict, and writes nothing", async () => {
    const d = await importRoster(env, W, rows(), { startDate: `${P}-01`, dryRun: true });
    expect(d.subs_reactivated.map((s) => s.subscription_id)).toEqual([S_PAUSED]);
    expect(d.subs_reactivated[0]).toMatchObject({ user_name: "回來了", plan_name: "ChatGPT", amount: 315 });
    expect(d.cancelled_conflicts.map((s) => s.subscription_id)).toEqual([S_CANCEL]);
    expect(d.subs_added).toEqual([]);   // the cancelled sub must NOT become a second subscription
    expect(d.subs_skipped).toBe(0);
    const st = await env.DB.prepare("SELECT status FROM subscriptions WHERE id=?").bind(S_PAUSED).first<{ status: string }>();
    expect(st?.status).toBe("paused");  // dry run wrote nothing
  });

  it("apply reactivates the paused sub without creating any payment row", async () => {
    await importRoster(env, W, rows(), { startDate: `${P}-01`, dryRun: false });
    const st = await env.DB.prepare("SELECT status FROM subscriptions WHERE id=?").bind(S_PAUSED).first<{ status: string }>();
    expect(st?.status).toBe("active");
    // No bill anywhere: not for the sub's old start month, not for the import period. The current
    // period's bill is 重新同步本期帳單's job (reconcilePeriodBills).
    const pays = await env.DB.prepare("SELECT COUNT(*) c FROM payments WHERE subscription_id=?").bind(S_PAUSED).first<{ c: number }>();
    expect(pays?.c).toBe(0);
  });

  it("apply leaves the cancelled sub cancelled and inserts no duplicate", async () => {
    await importRoster(env, W, rows(), { startDate: `${P}-01`, dryRun: false });
    const rowsOut = (await env.DB.prepare("SELECT id, status FROM subscriptions WHERE workspace_id=? AND user_id=?").bind(W, U_CANCEL).all<{ id: number; status: string }>()).results;
    expect(rowsOut).toEqual([{ id: S_CANCEL, status: "cancelled" }]);
  });

  it("after reactivation a re-run just skips the now-active sub", async () => {
    const d = await importRoster(env, W, rows(), { startDate: `${P}-01`, dryRun: true });
    expect(d.subs_reactivated).toEqual([]);
    expect(d.subs_skipped).toBe(1);
    expect(d.cancelled_conflicts.length).toBe(1); // the cancelled one still needs a human
  });
});
```

- [ ] **Step 2: Run tests**

Run: `pnpm --filter @chippot/worker test -- import.test.ts`
Expected: PASS. If a case fails, fix the TRUE branch in `importRoster` until it passes.

- [ ] **Step 3: Run the full suite + typecheck**

Run: `pnpm --filter @chippot/worker test && pnpm -r typecheck`
Expected: 254 passed (250 + 4 new cases), typecheck clean.

- [ ] **Step 4: Commit**

```bash
git add packages/worker/test/core/import.test.ts packages/worker/src/core/import.ts
git commit -m "test(import): TRUE 恢復 paused 訂閱；cancelled 只回報衝突且不重複建立"
```

---

## Task 5: Endpoint — `dry_run` defaults to true, returns the diff, audits only on apply

**Files:**
- Modify: `packages/worker/src/routes/admin.ts:206-229` (`membersImport`)
- Test: `packages/worker/test/routes/admin.test.ts` (the three existing import cases at `:295-314`, plus new cases)

**Interfaces:**
- Consumes: `importRoster(env, ws, rows, { startDate, dryRun })` → `ImportDiff`; `parseRosterCsv(csv)`; `writeAudit(db, entry)` from `packages/worker/src/core/audit.ts`.
- Produces: `POST /admin/members/import` → `200 { ok: true, diff: ImportDiff }` for **both** preview and apply. `dry_run` is read from the JSON body *or* the multipart form and is `true` unless explicitly `false` — the same safe default as `POST /admin/billing/:period/sync` (`admin.ts:115`). The `roster.import` audit row is written **only** when applying.

- [ ] **Step 1: Write the failing tests**

In `packages/worker/test/routes/admin.test.ts`, replace the three import cases (`imports a CSV (JSON body) and returns a summary`, `rejects a missing csv…`, `treats an empty start_date…`) with:

```ts
  it("defaults to a dry run: returns the diff and writes nothing", async () => {
    const csv = "姓名,帳號,ChatGPT\nPreviewOnly,previewonly@x.tw,TRUE";
    const res = await call("POST", "/admin/members/import", { csv, start_date: "2027-11-01" });
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as any;
    expect(body.diff.dry_run).toBe(true);
    expect(body.diff.period).toBe("2027-11");
    expect(body.diff.users_created.map((u: any) => u.email)).toEqual(["previewonly@x.tw"]);
    expect(await env.DB.prepare("SELECT id FROM users WHERE email='previewonly@x.tw'").first()).toBeNull();
    expect(await auditCount("roster.import", 1)).toBe(0); // a preview never audits
  });

  it("applies with dry_run:false, creates the member, and audits with diff counts", async () => {
    const csv = "姓名,帳號,ChatGPT,Claude Standard,Claude Premium\nNewMember,newmember@x.tw,TRUE,FALSE,FALSE";
    const res = await call("POST", "/admin/members/import", { csv, start_date: "2027-11-01", dry_run: false });
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as any;
    expect(body.diff.dry_run).toBe(false);
    expect(body.diff.users_created.length).toBe(1);
    expect(body.diff.subs_added.length).toBe(1);
    const u = await env.DB.prepare("SELECT id FROM users WHERE email='newmember@x.tw'").first<{ id: number }>();
    expect(u).not.toBeNull();
    expect(await auditCount("roster.import", 1)).toBe(1);
    const audit = await env.DB.prepare(
      "SELECT after_json FROM audit_logs WHERE action='roster.import' ORDER BY id DESC LIMIT 1"
    ).first<{ after_json: string }>();
    expect(JSON.parse(audit!.after_json)).toMatchObject({
      start_date: "2027-11-01", users_created: 1, subs_added: 1, subs_paused: 0, subs_reactivated: 0,
    });
  });

  it("accepts a multipart upload and honours dry_run=false as a form field", async () => {
    const fd = new FormData();
    fd.append("file", new Blob(["姓名,帳號,ChatGPT\nMultipart,multipart@x.tw,TRUE"], { type: "text/csv" }), "roster.csv");
    fd.append("start_date", "2027-11-01");
    fd.append("dry_run", "false");
    const res = await router.handle(new Request("https://x/admin/members/import", { method: "POST", body: fd }), env, { identity: IDENT });
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as any;
    expect(body.diff.dry_run).toBe(false);
    expect(await env.DB.prepare("SELECT id FROM users WHERE email='multipart@x.tw'").first()).not.toBeNull();
  });

  it("rejects a missing csv, a non-string csv, and a bad start_date", async () => {
    expect((await call("POST", "/admin/members/import", {}))!.status).toBe(400);
    expect((await call("POST", "/admin/members/import", { csv: 123 }))!.status).toBe(400);
    expect((await call("POST", "/admin/members/import", { csv: "姓名,帳號\nA,a@x.tw", start_date: "bad" }))!.status).toBe(400);
  });

  it("treats an empty start_date as the current month (no 400)", async () => {
    const res = await call("POST", "/admin/members/import", { csv: "姓名,帳號,ChatGPT\nEmptyStart,emptystart@x.tw,FALSE", start_date: "" });
    expect(res!.status).toBe(200);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @chippot/worker test -- admin.test.ts`
Expected: FAIL — the handler still applies unconditionally (so the dry-run case finds the user in the DB and an audit row) and returns `{ ok, summary }`, so `body.diff` is undefined.

- [ ] **Step 3: Write the implementation**

In `packages/worker/src/routes/admin.ts`, replace the whole `membersImport` function (lines 206-229) with:

```ts
/**
 * CSV roster import. dry_run defaults to true (safe preview) — only an explicit false applies,
 * matching POST /admin/billing/:period/sync. Both modes return the same ImportDiff so the admin's
 * preview and applied summary render from one shape; only an apply writes the audit entry.
 */
async function membersImport(req: Request, env: Env, ctx: RouteCtx): Promise<Response> {
  const ws = wsId(ctx);
  let csv: string | null = null;
  let startDate: string | undefined;
  let dryRun = true;
  const ct = req.headers.get("content-type") ?? "";
  if (ct.includes("multipart/form-data")) {
    let form: FormData;
    try { form = await req.formData(); } catch { return errorResponse(400, "expected a multipart form"); }
    const f = form.get("file");
    if (f && typeof f !== "string") csv = await (f as Blob).text();
    const sd = form.get("start_date");
    if (typeof sd === "string" && sd.trim()) startDate = sd.trim();
    dryRun = form.get("dry_run") !== "false";
  } else {
    const b = await readJson<{ csv?: unknown; start_date?: unknown; dry_run?: unknown }>(req);
    if (typeof b?.csv === "string") csv = b.csv;
    if (typeof b?.start_date === "string" && b.start_date.trim()) startDate = b.start_date.trim();
    dryRun = b?.dry_run !== false;
  }
  if (!csv) return errorResponse(400, "csv is required");
  if (startDate && !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) return errorResponse(400, "start_date must be YYYY-MM-DD");
  const start = startDate ?? `${taipeiPeriod()}-01`;
  const diff = await importRoster(env, ws, parseRosterCsv(csv), { startDate: start, dryRun });
  if (!dryRun) {
    await writeAudit(env.DB, {
      workspaceId: ws, actor: actorOf(ctx), action: "roster.import", entityType: "workspace", entityId: ws,
      after: {
        start_date: start,
        users_created: diff.users_created.length,
        users_updated: diff.users_updated,
        subs_added: diff.subs_added.length,
        subs_reactivated: diff.subs_reactivated.length,
        subs_paused: diff.subs_paused.length,
        cancelled_conflicts: diff.cancelled_conflicts.length,
        subs_skipped: diff.subs_skipped,
        rows_skipped: diff.rows_skipped,
        unmatched_plans: diff.unmatched_plans,
        affected_pending_bills: diff.affected_pending_bills.length,
      },
    });
  }
  return json({ ok: true, diff });
}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `pnpm --filter @chippot/worker test && pnpm -r typecheck`
Expected: 256 passed (254 + the dry-run-default and multipart cases; the other three import cases were rewritten in place), typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages/worker/src/routes/admin.ts packages/worker/test/routes/admin.test.ts
git commit -m "feat(admin-api): /members/import 預設 dry_run 預覽，回傳 ImportDiff，套用才寫稽核"
```

---

## Task 6: Admin API client types + a `DiffList` component of its own

**Files:**
- Modify: `packages/admin/src/api.ts:43-45` (add the import types next to the reconcile ones) and `:89-97` (`importMembers`)
- Create: `packages/admin/src/components/DiffList.tsx`

**Interfaces:**
- Consumes: the worker's `ImportDiff` JSON from Task 5 (field-for-field; the two packages are not type-linked, so these types are hand-mirrored and must match exactly).
- Produces:
  - `ImportUserLine`, `ImportSubLine`, `ImportBillLine`, `ImportDiff` exported from `packages/admin/src/api.ts`.
  - `api.importMembers(file: File, opts: { startDate?: string; dryRun: boolean }): Promise<{ ok: boolean; diff: ImportDiff }>`.
  - `DiffList({ title, rows }: { title: string; rows: string[] })` from `packages/admin/src/components/DiffList.tsx`.

This package has no test runner (see Global Constraints), so the gate here is typecheck + build.

- [ ] **Step 1: Add the types**

In `packages/admin/src/api.ts`, insert after the `ReconcileApplied` line (`:45`):

```ts
export interface ImportUserLine { user_id: number | null; user_name: string; email: string }
export interface ImportSubLine {
  subscription_id: number | null; user_id: number | null; user_name: string; email: string;
  plan_id: number; plan_name: string; amount: number;
}
export interface ImportBillLine {
  payment_id: number; subscription_id: number; user_name: string; plan_name: string;
  period: string; amount: number; status: string;
}
/** Mirrors ImportDiff in worker/src/core/import.ts — the same shape for a preview and an apply. */
export interface ImportDiff {
  dry_run: boolean; period: string;
  users_created: ImportUserLine[]; users_updated: number;
  subs_added: ImportSubLine[]; subs_reactivated: ImportSubLine[]; subs_paused: ImportSubLine[];
  cancelled_conflicts: ImportSubLine[];
  subs_skipped: number; rows_skipped: number; unmatched_plans: string[];
  affected_pending_bills: ImportBillLine[];
}
```

- [ ] **Step 2: Rewrite the client call**

In `packages/admin/src/api.ts`, replace `importMembers` (`:89-97`) with:

```ts
  importMembers: async (file: File, opts: { startDate?: string; dryRun: boolean }) => {
    const fd = new FormData();
    fd.append("file", file);
    if (opts.startDate) fd.append("start_date", opts.startDate);
    // The endpoint previews unless it sees exactly "false", so always send the flag explicitly.
    fd.append("dry_run", opts.dryRun ? "true" : "false");
    const r = await fetch(`${BASE}/members/import`, { method: "POST", body: fd });
    const data = (await r.json().catch(() => ({}))) as any;
    if (!r.ok) throw new Error(data?.error ?? `錯誤 ${r.status}`);
    return data as { ok: boolean; diff: ImportDiff };
  },
```

- [ ] **Step 3: Create the component**

Create `packages/admin/src/components/DiffList.tsx`:

```tsx
/**
 * Collapsible "N changed rows" list for a diff preview.
 *
 * Deliberately duplicated from the local DiffList inside views/Payments.tsx (the 重新同步本期帳單
 * modal) instead of extracted: that file is being rewritten in a parallel PR, so importing from it
 * would collide. Keep the two visually identical.
 */
export function DiffList({ title, rows }: { title: string; rows: string[] }) {
  return (
    <details style={{ margin: "6px 0" }}>
      <summary style={{ cursor: "pointer" }}>{title}（{rows.length}）</summary>
      <ul style={{ margin: "6px 0 0 18px", color: "var(--muted)", fontSize: 13 }}>
        {rows.map((r, i) => <li key={i}>{r}</li>)}
      </ul>
    </details>
  );
}
```

- [ ] **Step 4: Verify the gates**

Run: `pnpm --filter @chippot/admin typecheck`
Expected: FAIL with an error in `packages/admin/src/views/Settings.tsx` — `ImportModal` still calls `api.importMembers(file, start || undefined)` and reads `r.summary`. That is Task 7's job; do not fix it here, and do not commit a broken typecheck. Instead, commit Tasks 6 and 7 together at the end of Task 7.

- [ ] **Step 5: Stage (do not commit yet)**

```bash
git add packages/admin/src/api.ts packages/admin/src/components/DiffList.tsx
```

---

## Task 7: Two-step `ImportModal` — 選檔 → 預覽差異 → 確認套用

**Files:**
- Modify: `packages/admin/src/views/Settings.tsx:1-3` (imports), `:238` (the action-row copy), `:303-330` (`ImportModal`)
- **Must not touch** `packages/admin/src/views/Payments.tsx`.

**Interfaces:**
- Consumes: `api.importMembers(file, { startDate, dryRun })`, `ImportDiff`, `ImportSubLine` from `../api` (Task 6); `DiffList` from `../components/DiffList` (Task 6); `Stat`, `Modal`, `Field` from `../ui` (`ui.tsx:73`, `:34`, `:48`).

- [ ] **Step 1: Update the imports**

In `packages/admin/src/views/Settings.tsx`, replace lines 2-3 with:

```tsx
import { api, currentPeriod, nextBillingPeriod, type ImportDiff, type ImportSubLine } from "../api";
import { useAsync, Card, Field, Empty, Modal, Stat, IconCheck, IconWarning } from "../ui";
import { DiffList } from "../components/DiffList";
```

- [ ] **Step 2: Replace `ImportModal`**

Replace the whole `ImportModal` function (`:303-330`) with:

```tsx
const subLine = (l: ImportSubLine) => `${l.user_name || l.email}·${l.plan_name} NT$${l.amount.toLocaleString()}`;
const BILL_STATUS: Record<string, string> = { pending: "待繳", rejected: "已退回" };

function ImportModal({ onClose }: { onClose: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [start, setStart] = useState("");
  const [busy, setBusy] = useState(false);
  const [diff, setDiff] = useState<ImportDiff | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function preview() {
    if (!file) { setErr("請選擇 CSV 檔"); return; }
    setBusy(true); setErr(null);
    try {
      const r = await api.importMembers(file, { startDate: start || undefined, dryRun: true });
      setDiff(r.diff);
    } catch (e) { setErr((e as Error).message); }
    setBusy(false);
  }

  async function apply() {
    if (!file || busy) return; // belt: the button is also disabled while in flight
    setBusy(true); setErr(null);
    try {
      const r = await api.importMembers(file, { startDate: start || undefined, dryRun: false });
      const d = r.diff;
      setDiff(d);
      setDone(`✓ 已套用：新增 ${d.users_created.length} 人 / 新增 ${d.subs_added.length} 訂閱 / 恢復 ${d.subs_reactivated.length} / 暫停 ${d.subs_paused.length}`);
    } catch (e) { setErr((e as Error).message); }
    setBusy(false);
  }

  const changes = diff
    ? diff.users_created.length + diff.subs_added.length + diff.subs_reactivated.length + diff.subs_paused.length
    : 0;

  return (
    <Modal title="匯入名單 CSV" onClose={onClose}>
      {err && <div className="error-banner">{err}</div>}

      {!diff && (
        <>
          <p style={{ color: "var(--muted-strong)", fontSize: 13, margin: "0 0 12px" }}>
            欄位需為「姓名, 帳號, 方案名…」；方案名須與系統方案一致。方案格 <b>TRUE</b>＝訂閱、<b>FALSE</b>＝暫停該訂閱、<b>留空</b>＝不變動。起算月份留空＝當月。
          </p>
          <Field label="CSV 檔"><input type="file" accept=".csv,text/csv" onChange={(e) => setFile(e.target.files?.[0] ?? null)} disabled={busy} /></Field>
          <Field label="起算月份第一天（選填，YYYY-MM-DD）"><input value={start} onChange={(e) => setStart(e.target.value)} placeholder="2026-06-01" disabled={busy} /></Field>
          <button className="btn btn--primary" onClick={preview} disabled={busy}>{busy ? "計算差異中…" : "預覽差異"}</button>
        </>
      )}

      {diff && (
        <>
          {done && <div style={{ color: "var(--teal)", padding: "8px 0" }}>{done}</div>}
          <div className="stats">
            <Stat label="新成員" value={diff.users_created.length} />
            <Stat label="新增訂閱" value={diff.subs_added.length} />
            <Stat label="恢復訂閱" value={diff.subs_reactivated.length} />
            <Stat label="暫停訂閱" value={diff.subs_paused.length} />
          </div>

          {diff.users_created.length > 0 && <DiffList title="新成員" rows={diff.users_created.map((u) => `${u.user_name || "（未填姓名）"}·${u.email}`)} />}
          {diff.subs_added.length > 0 && <DiffList title="新增訂閱" rows={diff.subs_added.map(subLine)} />}
          {diff.subs_reactivated.length > 0 && <DiffList title="恢復訂閱（暫停→啟用）" rows={diff.subs_reactivated.map(subLine)} />}
          {diff.subs_paused.length > 0 && <DiffList title="暫停訂閱（CSV 為 FALSE）" rows={diff.subs_paused.map(subLine)} />}
          {diff.cancelled_conflicts.length > 0 && (
            <>
              <div className="warnnote">下列訂閱已被<b>取消</b>（不是暫停），匯入不會自動恢復；如要恢復請到「成員／訂閱」手動改狀態。</div>
              <DiffList title="需人工處理（已取消）" rows={diff.cancelled_conflicts.map(subLine)} />
            </>
          )}
          {diff.affected_pending_bills.length > 0 && (
            <>
              <div className="warnnote">
                被暫停的訂閱在 {diff.period} 還有 {diff.affected_pending_bills.length} 筆未繳帳單。匯入<b>不會</b>變更任何帳單；請到「繳費審核」按<b>重新同步本期帳單</b>清理。
              </div>
              <DiffList
                title={`${diff.period} 未繳帳單（匯入不會變更）`}
                rows={diff.affected_pending_bills.map((b) => `${b.user_name}·${b.plan_name} NT$${b.amount.toLocaleString()}（${BILL_STATUS[b.status] ?? b.status}）`)}
              />
            </>
          )}

          <p style={{ color: "var(--muted)", fontSize: 13, margin: "10px 0" }}>
            同步姓名 {diff.users_updated} 人 · 已訂閱跳過 {diff.subs_skipped} · 略過 {diff.rows_skipped} 列
            {diff.unmatched_plans.length > 0 && ` · 對不到的方案：${diff.unmatched_plans.join(", ")}`}
          </p>

          {!done && (
            <>
              {changes === 0 && <p style={{ color: "var(--muted)" }}>沒有新增／暫停／恢復；套用只會同步 {diff.users_updated} 位成員的姓名。</p>}
              <button className="btn btn--primary" onClick={apply} disabled={busy}>{busy ? "套用中…" : "確認套用"}</button>
            </>
          )}
        </>
      )}
    </Modal>
  );
}
```

- [ ] **Step 3: Update the action-row copy so it matches what the button now does**

In `packages/admin/src/views/Settings.tsx:238`, replace that `ActionRow` with:

```tsx
          <ActionRow title="匯入名單 CSV" tag="會新增/暫停訂閱" warn desc="用 CSV 批次建立或更新成員與訂閱；FALSE 的方案會暫停該訂閱。套用前先看差異預覽。"><ImportRoster /></ActionRow>
```

- [ ] **Step 4: Run the gates**

Run: `pnpm --filter @chippot/admin typecheck && pnpm --filter @chippot/admin build`
Expected: both PASS.

- [ ] **Step 5: Confirm `Payments.tsx` is untouched**

Run: `git status --porcelain packages/admin/src/views/Payments.tsx`
Expected: empty output. If anything is listed, `git checkout -- packages/admin/src/views/Payments.tsx` and redo the change without touching it.

- [ ] **Step 6: Commit Tasks 6 + 7 together**

```bash
git add packages/admin/src/api.ts packages/admin/src/components/DiffList.tsx packages/admin/src/views/Settings.tsx
git commit -m "feat(admin-ui): 匯入名單改為兩段式（差異預覽 → 確認套用）"
```

---

## Task 8: Docs + PR

**Files:**
- Modify: `README.md:12` (test badge) and `README.md:52-53` (the CSV-import highlight) and `README.md:67` (the test-count sentence)

- [ ] **Step 1: Get the real numbers**

Run: `pnpm -r test && pnpm -r typecheck && pnpm -r build`
(the root `build` needs `VITE_API_BASE`, exactly as CI does it: `VITE_API_BASE=https://example.invalid pnpm -r build`)
Note the exact `Tests  N passed (N)` line from the worker run — expected **256**. Use the number vitest actually printed, never a guessed one.

- [ ] **Step 2: Update the README**

Replace `README.md:12`:

```markdown
![Vitest](https://img.shields.io/badge/tests-256%20passing-0f6e63?logo=vitest&logoColor=white)
```

Replace the CSV bullet (`:52-53`):

```markdown
- 📥 **CSV roster import** — onboard *and* maintain a roster (e.g. a Google-Forms export) from one
  upload: a plan cell of `TRUE` subscribes (or un-pauses), `FALSE` pauses that subscription, blank
  leaves it alone. Every run previews a full diff (new members, added / paused / reactivated subs,
  plans it couldn't match, cancelled subs that need a human) before you apply it; idempotent re-runs.
```

Replace the count in `:67`:

```markdown
- 🧪 **Real-runtime tests** — 256 Vitest cases run against actual Miniflare D1 + R2 (FK constraints
```

- [ ] **Step 3: Commit and push**

```bash
git add README.md
git commit -m "docs(readme): 匯入名單支援 FALSE 暫停 + 差異預覽（測試數 243 → 256）"
git push -u origin feat/28-import-pause-diff
```

- [ ] **Step 4: Open the PR**

```bash
gh pr create --title "feat(import): CSV 匯入支援退訂（FALSE→暫停）與差異預覽" --body "$(cat <<'EOF'
## 做了什麼

CSV 名單匯入現在會處理「退訂」，並在套用前顯示完整差異預覽（比照繳費審核的 **重新同步本期帳單**）。

### 匯入語意（方案欄）
| CSV 值 | 現有訂閱狀態 | 結果 |
|---|---|---|
| `FALSE` | active | → **paused**（可逆，非 cancelled） |
| `FALSE` | paused / cancelled / 無 | 不變動 |
| 留空／其他 | 任何 | 不變動 |
| `TRUE` | active | 跳過 |
| `TRUE` | paused | → **active**（恢復） |
| `TRUE` | cancelled | **不**自動恢復，列為需人工處理的衝突（同時修掉舊程式會多建一筆重複訂閱的問題） |
| `TRUE` | 無 | 新建 active 訂閱 + 首期帳單 |

標題列沒有的方案欄，永遠不會被動到。

### 差異預覽
- `POST /admin/members/import` 的 `dry_run` **預設 true**（與 `POST /admin/billing/:period/sync` 一致），`dry_run:false` 才會寫入並留下 `roster.import` 稽核（含各項計數）。
- 兩種模式都回傳同一個 `ImportDiff`，後台 Modal 改為：選檔 → 預覽差異 → 確認套用。
- 恢復訂閱**不會**補開帳單：`ensureFirstPayment` 會用訂閱原始 `start_date` 的月份（對久前暫停的訂閱會開到早已結束的期別）。本期帳單一律交給**重新同步本期帳單**處理。
- `affected_pending_bills` 只回報、不變更：被暫停訂閱在本期還沒繳的帳單會列出來，並提示到「繳費審核」按重新同步清理。

## 測試
`pnpm -r test` 243 → 256 全綠（解析器、dry-run/套用、暫停、恢復、cancelled 衝突不重複建立、重複 email 合併、endpoint 預設 dry-run／multipart／稽核）。

Closes #28
EOF
)"
```

- [ ] **Step 5: Confirm CI is green**

Run: `gh pr checks --watch`
Expected: the `check` job passes (typecheck, tests, build, and the web-build fail-fast guard).

---

## Self-Review

**1. Spec coverage**

| Spec item | Where |
|---|---|
| 1. FALSE + active → paused | Task 2 (FALSE branch of `importRoster`), proven in Task 3 |
| 2. Blank/other → untouched | Task 1 (parser puts them in neither list) + Task 1 Step 1's second test |
| 3. Plan columns absent from the header → never touched | Task 3's `S_KEEP` assertion (Claude Standard absent from the row → still `active`) |
| 4. TRUE + paused → reactivate; payment-row decision | Task 2 (`reactivate` branch + the doc comment justifying "no payment row"), proven in Task 4 ("apply reactivates … without creating any payment row") |
| 5. TRUE + cancelled → conflict, no duplicate | Task 2 (`conflicts` branch replaces the old unconditional `else INSERT`), proven in Task 4's two cases |
| 6. TRUE + active → skipped; TRUE + none → sub + first payment; new users created | Task 2's first two `importRoster` cases (the pre-existing behavior, re-expressed) |
| 7. `dryRun` returns a structured diff; apply returns the same; all buckets incl. report-only `affected_pending_bills` | Task 2 (`ImportDiff` + two-phase) and `loadAffectedBills`; report-only proven in Task 3's apply case |
| 8. Endpoint `dry_run` default true; apply audits diff counts | Task 5 |
| 9. Two-step ImportModal, zh-TW, visually consistent with the reconcile SyncModal | Tasks 6–7 (`Stat` tiles + `DiffList` per bucket, both mirroring `SyncModal`) |
| Coordination: `Payments.tsx` untouched, reuse by duplication | Global Constraints + Task 6 Step 3 (new `components/DiffList.tsx`) + Task 7 Step 5 (`git status` check) |
| 243 tests stay green; admin gates = typecheck + build | Global Constraints; a full-suite run ends every worker task |

**2. Placeholder scan:** no TBD/TODO/"similar to Task N"/"add error handling" anywhere; every code step carries the literal code, and the two "no source change expected" tasks (3 and 4) say exactly what to do if a test fails instead.

**3. Type consistency:** `RosterRow.plansOff` (Task 1) is consumed by name in Task 2's FALSE loop and by every test fixture. `ImportOptions { startDate, dryRun }` is used identically in Tasks 2–5. `ImportDiff` field names (`dry_run`, `period`, `users_created`, `users_updated`, `subs_added`, `subs_reactivated`, `subs_paused`, `cancelled_conflicts`, `subs_skipped`, `rows_skipped`, `unmatched_plans`, `affected_pending_bills`) are identical in the worker interface (Task 2), the tests (Tasks 2–5), the audit payload (Task 5), the admin mirror type (Task 6), and every read in `ImportModal` (Task 7). `ImportSubLine` carries `subscription_id | null` — the UI never dereferences it, it only formats `user_name`/`email`/`plan_name`/`amount`. `api.importMembers(file, { startDate, dryRun })` has one shape, used once in each of `preview()` and `apply()`. `DiffList({ title, rows })` matches its only call sites.
