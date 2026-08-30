import type { Env } from "../env";
import { nowUtcIso } from "./time";
import { ensureFirstPayment } from "./billing";

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
   *  touches payments here — the admin clears them with 重新同步此期帳單. */
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
 * period. The current period's bill is exactly what 重新同步此期帳單 (reconcilePeriodBills) creates
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
 * they are, and the admin clears them with 重新同步此期帳單 (reconcilePeriodBills), which already
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
