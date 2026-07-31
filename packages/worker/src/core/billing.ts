import type { Env } from "../env";
import { parseSettings } from "../env";
import { nowUtcIso, periodStart, periodEnd, dueDate } from "./time";
import { writeAudit } from "./audit";
import { claimNotification, isBillingOpened, type Notifier, type PlanOpenLine } from "./notify";

export interface PeriodDates {
  period_start: string;
  period_end: string;
  due_date: string;
}

/** Month bounds + due date for a YYYY-MM period given a billing day (1..28). */
export function buildPeriodDates(period: string, billingDay: number): PeriodDates {
  return {
    period_start: periodStart(period),
    period_end: periodEnd(period),
    due_date: dueDate(period, billingDay),
  };
}

export interface EnsureResult {
  paymentId: number;
  created: boolean;
}

interface SubBillingRow {
  workspace_id: number;
  billing_day: number;
  amount: number;
}

async function loadSubBilling(
  db: D1Database,
  subscriptionId: number
): Promise<SubBillingRow> {
  const row = await db
    .prepare(
      `SELECT s.workspace_id AS workspace_id, s.billing_day AS billing_day, p.monthly_amount AS amount
       FROM subscriptions s JOIN plans p ON p.id = s.plan_id
       WHERE s.id = ?`
    )
    .bind(subscriptionId)
    .first<SubBillingRow>();
  if (!row) throw new Error(`subscription ${subscriptionId} not found`);
  return row;
}

/**
 * Idempotently create the pending payment for (subscription, period). Safe to call
 * repeatedly (cron) thanks to UNIQUE(subscription_id, period) + ON CONFLICT DO NOTHING.
 * Amount defaults to the plan's monthly_amount (overridable later per payment).
 */
export async function ensurePeriodPayment(
  db: D1Database,
  subscriptionId: number,
  period: string,
  opts?: { source?: string }
): Promise<EnsureResult> {
  const sub = await loadSubBilling(db, subscriptionId);
  const dates = buildPeriodDates(period, sub.billing_day);
  const now = nowUtcIso();
  const res = await db
    .prepare(
      `INSERT INTO payments
        (workspace_id, subscription_id, period, period_start, period_end, due_date,
         amount, status, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
       ON CONFLICT(subscription_id, period) DO NOTHING`
    )
    .bind(
      sub.workspace_id, subscriptionId, period,
      dates.period_start, dates.period_end, dates.due_date,
      sub.amount, opts?.source ?? "cron", now, now
    )
    .run();
  const created = (res.meta.changes ?? 0) > 0;
  const existing = await db
    .prepare("SELECT id FROM payments WHERE subscription_id = ? AND period = ?")
    .bind(subscriptionId, period)
    .first<{ id: number }>();
  return { paymentId: existing!.id, created };
}

/**
 * Create the first period's payment when a subscription is created. The first month is
 * not pro-rated (spec §8): the period is simply the start_date's YYYY-MM (start_date is
 * already an Asia/Taipei business date).
 */
export async function ensureFirstPayment(
  db: D1Database,
  subscriptionId: number
): Promise<EnsureResult> {
  const sub = await db
    .prepare("SELECT start_date FROM subscriptions WHERE id = ?")
    .bind(subscriptionId)
    .first<{ start_date: string }>();
  if (!sub) throw new Error(`subscription ${subscriptionId} not found`);
  const period = sub.start_date.slice(0, 7);
  return ensurePeriodPayment(db, subscriptionId, period);
}

// ── Manual "發起繳費" (confirm amounts + open billing) ─────────────────────────

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
  /** Bills this call actually created for the period (0 on a re-run — the insert is idempotent). */
  createdPayments: number;
  /** PENDING bills whose amount really changed (no-op rewrites are not counted). */
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
  let createdPayments = 0;
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
  for (const s of subs.results) {
    const r = await ensurePeriodPayment(env.DB, s.id, period);
    if (r.created) createdPayments++;
  }
  for (const [planId, amount] of amountByPlan) {
    const res = await env.DB
      .prepare(
        `UPDATE payments SET amount = ?, updated_at = ?
         WHERE workspace_id = ? AND period = ? AND status = 'pending' AND amount != ?
           AND subscription_id IN (SELECT id FROM subscriptions WHERE workspace_id = ? AND plan_id = ? AND status = 'active')`
      )
      .bind(amount, now, workspaceId, period, amount, workspaceId, planId)
      .run();
    updatedPayments += res.meta.changes ?? 0;
  }

  // Notify (claim the shared billing_opened slot — cron uses the same key).
  const ws = await env.DB.prepare("SELECT settings FROM workspaces WHERE id = ?").bind(workspaceId).first<{ settings: string }>();
  const settings = parseSettings(ws!.settings);
  const channelId = settings.discord_billing_channel_id;
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
        await notifier.sendBillingOpened(env, channelId, period, lines, settings.billing_opened_template);
        sent = true;
      }
    }
  }

  await writeAudit(env.DB, {
    workspaceId, actor, action: "billing.initiate", entityType: "workspace", entityId: workspaceId,
    after: { period, updatedPlans, createdPayments, updatedPayments, sent },
  });

  return { sent, updatedPlans, createdPayments, updatedPayments };
}

// ── "立即重發開繳通知" (re-post the notice only — never touches bills or prices) ──

export type ResendOutcome = "sent" | "preview" | "not_opened" | "no_channel" | "no_bot_token" | "no_plans";

export interface ResendBillingResult {
  outcome: ResendOutcome;
  sent: boolean;
  /** The plan lines the notice does / would list. */
  lines: PlanOpenLine[];
}

/**
 * Re-post an ALREADY-OPENED period's billing-opened notice. Unlike initiateBillingOpened this
 * writes no prices and creates no bills — "重發" means exactly what it says.
 *
 * The dedup slot is REFRESHED with an UPDATE rather than deleted-then-reclaimed, so the period is
 * never momentarily readable as "unopened": members' pay button, reconcile and retract all key off
 * that single row, and a delete-then-claim window would make a resend look like a half retract.
 *
 * The plan lines come from the SAME query the cron uses (scheduled.ts step 2), so the admin resend
 * and the automatic notice can never list a different set of plans.
 */
export async function resendBillingOpenedNotice(
  env: Env,
  workspaceId: number,
  period: string,
  notifier: Notifier,
  opts: { dryRun: boolean }
): Promise<ResendBillingResult> {
  const bare = (outcome: ResendOutcome): ResendBillingResult => ({ outcome, sent: false, lines: [] });

  if (!(await isBillingOpened(env.DB, workspaceId, period))) return bare("not_opened");
  const wsRow = await env.DB.prepare("SELECT settings FROM workspaces WHERE id = ?").bind(workspaceId).first<{ settings: string }>();
  if (!wsRow) return bare("not_opened");
  const settings = parseSettings(wsRow.settings);
  const channelId = settings.discord_billing_channel_id;
  if (!channelId) return bare("no_channel");
  if (!env.DISCORD_BOT_TOKEN) return bare("no_bot_token");

  const lines = (await env.DB
    .prepare(
      `SELECT pl.id AS plan_id, pl.name AS plan_name, pl.monthly_amount AS amount, pl.discord_role_id AS role_id
       FROM plans pl
       WHERE pl.workspace_id = ? AND pl.active = 1
         AND EXISTS (SELECT 1 FROM subscriptions s WHERE s.plan_id = pl.id AND s.status = 'active')
       ORDER BY pl.id`
    )
    .bind(workspaceId)
    .all<PlanOpenLine>()).results;
  if (lines.length === 0) return { outcome: "no_plans", sent: false, lines };
  if (opts.dryRun) return { outcome: "preview", sent: false, lines };

  await notifier.sendBillingOpened(env, channelId, period, lines, settings.billing_opened_template);
  await env.DB
    .prepare("UPDATE notification_logs SET sent_at = ? WHERE workspace_id = ? AND type = 'billing_opened' AND period = ?")
    .bind(nowUtcIso(), workspaceId, period)
    .run();
  return { outcome: "sent", sent: true, lines };
}

// ── "重新同步本期帳單" (reconcile a period's bills to the current roster) ──────────

export interface ReconcileLine {
  payment_id?: number;
  subscription_id: number;
  user_id: number;
  user_name: string;
  plan_name: string;
  amount: number;
  from?: number;
  to?: number;
  discord_id: string | null;
  screenshot_key?: string | null;
}
export interface ReconcileDiff {
  opened: boolean;
  add: ReconcileLine[];
  remove: ReconcileLine[];
  reprice: ReconcileLine[];
  frozen_count: number;
}

/** A period is "opened" once its billing_opened notice has been claimed — that is what members can pay against. */
function isPeriodOpened(env: Env, workspaceId: number, period: string): Promise<boolean> {
  return isBillingOpened(env.DB, workspaceId, period);
}

/** Drop proof objects of removed bills whose key no longer belongs to any remaining payment (proofs can be shared). */
async function sweepOrphanProofs(env: Env, removed: ReconcileLine[]): Promise<void> {
  if (!env.BUCKET) return;
  const keys = [...new Set(removed.map((r) => r.screenshot_key).filter((k): k is string => !!k))];
  for (const k of keys) {
    const still = await env.DB.prepare("SELECT 1 AS ok FROM payments WHERE screenshot_key = ? LIMIT 1").bind(k).first<{ ok: number }>();
    if (!still) await env.BUCKET.delete(k).catch(() => {});
  }
}

/**
 * Reconcile a period's bills against the current active roster (manual "重新同步本期帳單").
 * add: an active sub with no bill → pending @ current plan price. remove: a pending/rejected bill of
 * a non-active sub → delete (+ R2 proof + matching upload_token cleanup). reprice: an active sub's
 * PENDING bill → current plan price. paid/verified are frozen. Only "opened" periods (those with a
 * billing_opened log) do anything — matches what members can actually pay.
 */
export async function reconcilePeriodBills(
  env: Env,
  workspaceId: number,
  period: string,
  opts: { dryRun: boolean }
): Promise<ReconcileDiff> {
  if (!(await isPeriodOpened(env, workspaceId, period))) return { opened: false, add: [], remove: [], reprice: [], frozen_count: 0 };

  const activeSubs = (await env.DB.prepare(
    `SELECT s.id AS subscription_id, s.user_id AS user_id, s.billing_day AS billing_day,
            u.display_name AS user_name, u.discord_id AS discord_id,
            pl.name AS plan_name, pl.monthly_amount AS price
     FROM subscriptions s JOIN users u ON u.id = s.user_id JOIN plans pl ON pl.id = s.plan_id
     WHERE s.workspace_id = ? AND s.status = 'active'`
  ).bind(workspaceId).all<{ subscription_id: number; user_id: number; billing_day: number; user_name: string; discord_id: string | null; plan_name: string; price: number }>()).results;
  const activeBySub = new Map(activeSubs.map((s) => [s.subscription_id, s]));

  const existing = (await env.DB.prepare(
    `SELECT p.id AS payment_id, p.subscription_id AS subscription_id, p.amount AS amount, p.status AS status,
            p.screenshot_key AS screenshot_key, s.status AS sub_status, s.user_id AS user_id,
            u.display_name AS user_name, u.discord_id AS discord_id, pl.name AS plan_name
     FROM payments p JOIN subscriptions s ON s.id = p.subscription_id
     JOIN users u ON u.id = s.user_id JOIN plans pl ON pl.id = s.plan_id
     WHERE p.workspace_id = ? AND p.period = ?`
  ).bind(workspaceId, period).all<{ payment_id: number; subscription_id: number; amount: number; status: string; screenshot_key: string | null; sub_status: string; user_id: number; user_name: string; discord_id: string | null; plan_name: string }>()).results;

  const bySub = new Map(existing.map((e) => [e.subscription_id, e]));
  const add: ReconcileLine[] = [], reprice: ReconcileLine[] = [], remove: ReconcileLine[] = [];
  let frozen_count = 0;

  for (const s of activeSubs) {
    const e = bySub.get(s.subscription_id);
    if (!e) {
      add.push({ subscription_id: s.subscription_id, user_id: s.user_id, user_name: s.user_name, plan_name: s.plan_name, amount: s.price, discord_id: s.discord_id });
    } else if (e.status === "pending" && e.amount !== s.price) {
      reprice.push({ payment_id: e.payment_id, subscription_id: s.subscription_id, user_id: s.user_id, user_name: s.user_name, plan_name: s.plan_name, amount: s.price, from: e.amount, to: s.price, discord_id: s.discord_id });
    }
  }
  for (const e of existing) {
    if (e.status === "paid" || e.status === "verified") { frozen_count++; continue; }
    if (e.sub_status !== "active") {
      remove.push({ payment_id: e.payment_id, subscription_id: e.subscription_id, user_id: e.user_id, user_name: e.user_name, plan_name: e.plan_name, amount: e.amount, discord_id: e.discord_id, screenshot_key: e.screenshot_key });
    }
  }

  if (opts.dryRun) return { opened: true, add, remove, reprice, frozen_count };

  // Apply add/reprice/remove in ONE batch (implicit transaction) so a partial failure can't leave
  // the period half-reconciled. Adds are admin-initiated pending bills at the current plan price
  // (payments.source CHECK allows: user/user_slash/user_web/admin_manual/cron).
  const now = nowUtcIso();
  const stmts: D1PreparedStatement[] = [];
  for (const a of add) {
    const s = activeBySub.get(a.subscription_id)!;
    const dates = buildPeriodDates(period, s.billing_day);
    stmts.push(env.DB.prepare(
      `INSERT INTO payments (workspace_id, subscription_id, period, period_start, period_end, due_date, amount, status, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 'admin_manual', ?, ?)
       ON CONFLICT(subscription_id, period) DO NOTHING`
    ).bind(workspaceId, a.subscription_id, period, dates.period_start, dates.period_end, dates.due_date, a.amount, now, now));
  }
  for (const rp of reprice) stmts.push(env.DB.prepare("UPDATE payments SET amount = ?, updated_at = ? WHERE id = ? AND status = 'pending'").bind(rp.to!, now, rp.payment_id!));
  for (const rm of remove) {
    stmts.push(env.DB.prepare("DELETE FROM upload_tokens WHERE workspace_id = ? AND subscription_id = ? AND period = ?").bind(workspaceId, rm.subscription_id, period));
    // Re-assert status in the DELETE so a concurrent verify/pay between compute and apply isn't clobbered.
    stmts.push(env.DB.prepare("DELETE FROM payments WHERE id = ? AND status IN ('pending','rejected')").bind(rm.payment_id!));
  }
  if (stmts.length) await env.DB.batch(stmts);
  await sweepOrphanProofs(env, remove);

  return { opened: true, add, remove, reprice, frozen_count };
}

// ── "收回本期開繳" (retract a period that should never have been opened) ────────

/** What the apply batch actually did, read back from each statement's meta.changes. */
export interface RetractEffects {
  removed: number;
  frozen: number;
  /** False when someone else's retract cleared the marker first — this call retracted nothing. */
  marker_cleared: boolean;
}

export interface RetractResult {
  opened: boolean;
  /** Preview of the bills to delete, as seen when the diff was computed. */
  removed: ReconcileLine[];
  frozen_count: number;
  /** Apply only (absent on a dry run or an already-unopened period); the real, post-batch truth. */
  applied?: RetractEffects;
}

/**
 * Retract a period's billing (manual "收回本期開繳") — the way back from a mis-opened month (a
 * slipped 發起繳費, or the cron running on a month nobody meant to bill). Deletes every
 * pending/rejected bill of the period (+ its upload_tokens and orphaned R2 proofs, same as
 * reconcile's remove path) and drops the period's billing_opened AND overdue notification slots, so
 * the period reads as "unopened" again: reconcile stops refilling it, and a later re-open can both
 * notify and remind afresh.
 * paid/verified bills are frozen and reported as frozen_count — settled money is never rewritten,
 * and re-opening the period leaves those rows alone (UNIQUE(subscription_id, period)).
 * Unlike reconcile, the subscription's roster status is irrelevant: the whole period is retracted.
 * Discord notices already sent are left as-is (owner decision: retracts happen before members read).
 */
export async function retractPeriodBilling(
  env: Env,
  workspaceId: number,
  period: string,
  opts: { dryRun: boolean }
): Promise<RetractResult> {
  if (!(await isPeriodOpened(env, workspaceId, period))) return { opened: false, removed: [], frozen_count: 0 };

  const existing = (await env.DB.prepare(
    `SELECT p.id AS payment_id, p.subscription_id AS subscription_id, p.amount AS amount, p.status AS status,
            p.screenshot_key AS screenshot_key, s.user_id AS user_id,
            u.display_name AS user_name, u.discord_id AS discord_id, pl.name AS plan_name
     FROM payments p JOIN subscriptions s ON s.id = p.subscription_id
     JOIN users u ON u.id = s.user_id JOIN plans pl ON pl.id = s.plan_id
     WHERE p.workspace_id = ? AND p.period = ?`
  ).bind(workspaceId, period).all<{ payment_id: number; subscription_id: number; amount: number; status: string; screenshot_key: string | null; user_id: number; user_name: string; discord_id: string | null; plan_name: string }>()).results;

  const removed: ReconcileLine[] = [];
  let frozen_count = 0;
  for (const e of existing) {
    if (e.status === "paid" || e.status === "verified") { frozen_count++; continue; }
    removed.push({ payment_id: e.payment_id, subscription_id: e.subscription_id, user_id: e.user_id, user_name: e.user_name, plan_name: e.plan_name, amount: e.amount, discord_id: e.discord_id, screenshot_key: e.screenshot_key });
  }

  if (opts.dryRun) return { opened: true, removed, frozen_count };

  // ONE batch: a half-applied retract (bills gone, period still "opened") is the worst outcome —
  // the next reconcile would refill exactly what we just deleted. Statement order is fixed so each
  // one's meta.changes can be read back below.
  //
  // Every DELETE is SET-BASED over (workspace, period) instead of over the ids in the snapshot
  // above. The snapshot is a read; rows can appear between it and this batch (the cron at
  // scheduled.ts, or another admin's 發起繳費), and such a row must not survive inside a period we
  // are about to mark unopened. Status stays in the WHERE clause, so frozen money is untouchable
  // no matter what changed since the snapshot.
  const frozenSubs = `SELECT subscription_id FROM payments
                       WHERE workspace_id = ? AND period = ? AND status IN ('paid','verified')`;
  const res = await env.DB.batch([
    // Every token that can still settle this period, except those of a surviving frozen bill.
    // NULL subscription_id is the normal case, not an edge one: createUploadLink mints a
    // period-wide token whenever the caller omits subscription_id, which the admin UI always does.
    env.DB.prepare(
      `DELETE FROM upload_tokens
        WHERE workspace_id = ? AND period = ?
          AND (subscription_id IS NULL OR subscription_id NOT IN (${frozenSubs}))`
    ).bind(workspaceId, period, workspaceId, period),
    env.DB.prepare("DELETE FROM payments WHERE workspace_id = ? AND period = ? AND status IN ('pending','rejected')")
      .bind(workspaceId, period),
    // billing_opened is what makes the period "open"; its own changes count tells us whether THIS
    // call is the one that closed the period (see marker_cleared).
    env.DB.prepare("DELETE FROM notification_logs WHERE workspace_id = ? AND type = 'billing_opened' AND period = ?")
      .bind(workspaceId, period),
    // The overdue slot is claimed once per (workspace, period) and never expires, so leaving it
    // behind would permanently mute overdue reminders if this period is ever re-opened —
    // claimNotification would lose and sendOverdueForPeriod would just return 0, with no error
    // anywhere. Kept as its own statement so it cannot inflate the marker's changes count.
    // ('receipt' is declared in the type union but never claimed, so there is no slot to release.)
    env.DB.prepare("DELETE FROM notification_logs WHERE workspace_id = ? AND type = 'overdue' AND period = ?")
      .bind(workspaceId, period),
  ]);
  await sweepOrphanProofs(env, removed);

  // Whatever is still standing in this period is, by definition, paid or verified — count it for
  // real rather than reporting the pre-batch snapshot's tally.
  const frozen = (await env.DB.prepare(
    "SELECT COUNT(*) AS c FROM payments WHERE workspace_id = ? AND period = ? AND status IN ('paid','verified')"
  ).bind(workspaceId, period).first<{ c: number }>())!.c;

  return {
    opened: true, removed, frozen_count,
    applied: {
      removed: res[1]!.meta.changes ?? 0,
      frozen,
      marker_cleared: (res[2]!.meta.changes ?? 0) > 0,
    },
  };
}
