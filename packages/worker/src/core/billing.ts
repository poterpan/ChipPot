import type { Env } from "../env";
import { parseSettings } from "../env";
import { nowUtcIso, periodStart, periodEnd, dueDate } from "./time";
import { writeAudit } from "./audit";
import { claimNotification, type Notifier, type PlanOpenLine } from "./notify";

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
  notifier: Notifier,
  opts?: { force?: boolean }
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
  const settings = parseSettings(ws!.settings);
  const channelId = settings.discord_billing_channel_id;
  let sent = false;
  if (channelId && env.DISCORD_BOT_TOKEN) {
    if (opts?.force) {
      // force = admin "resend now": clear the slot so the claim below re-sends. Non-atomic
      // delete-then-claim, but force is an occasional single-admin action (button disabled
      // in flight); worst case is a duplicate notice from two concurrent resends — accepted.
      await env.DB.prepare("DELETE FROM notification_logs WHERE workspace_id = ? AND type = 'billing_opened' AND period = ?")
        .bind(workspaceId, period).run();
    }
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
    after: { period, updatedPlans, updatedPayments, sent },
  });

  return { sent, updatedPlans, updatedPayments };
}
