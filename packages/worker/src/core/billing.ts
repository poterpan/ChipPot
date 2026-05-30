import { nowUtcIso, periodStart, periodEnd, dueDate } from "./time";

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
