import type { Env } from "../env";
import { parseSettings } from "../env";
import { taipeiPeriod, taipeiDate, taipeiDayOfMonth, daysBetween } from "./time";
import { ensurePeriodPayment } from "./billing";
import { runRetention } from "./retention";
import { claimNotification, type Notifier, type PlanOpenLine, type OverduePerson } from "./notify";

export interface DailySummary {
  paymentsEnsured: number;
  billingOpenedSent: number;
  overdueSent: number;
  proofsDeleted: number;
}

/**
 * Daily cron core (spec §8.1, §9, §13). Idempotent: creating payments uses
 * UNIQUE(subscription_id, period); notifications use notification_logs dedup. Business
 * day is Asia/Taipei (cron fires in UTC). Channel-agnostic — sending goes through Notifier.
 */
export async function runDailyTasks(
  env: Env,
  now: Date,
  notifier: Notifier
): Promise<DailySummary> {
  const summary: DailySummary = { paymentsEnsured: 0, billingOpenedSent: 0, overdueSent: 0, proofsDeleted: 0 };
  const dayOfMonth = taipeiDayOfMonth(now);
  const period = taipeiPeriod(now);

  const workspaces = await env.DB
    .prepare("SELECT id, billing_day, settings FROM workspaces")
    .all<{ id: number; billing_day: number; settings: string }>();

  for (const ws of workspaces.results) {
    const settings = parseSettings(ws.settings);
    const channelId = settings.discord_billing_channel_id;
    // Only attempt notifications when we can actually send — otherwise don't consume the
    // dedup slot, so they fire once the bot token / channel is configured.
    const canNotify = !!channelId && !!env.DISCORD_BOT_TOKEN;

    // 1. Create this period's payment for any subscription billing today.
    const subs = await env.DB
      .prepare("SELECT id, billing_day, custom_cycle FROM subscriptions WHERE workspace_id = ? AND status = 'active'")
      .bind(ws.id)
      .all<{ id: number; billing_day: number; custom_cycle: number }>();
    for (const s of subs.results) {
      const billDay = s.custom_cycle ? s.billing_day : ws.billing_day;
      if (billDay === dayOfMonth) {
        await ensurePeriodPayment(env.DB, s.id, period);
        summary.paymentsEnsured++;
      }
    }

    // 2. Billing-opened notice on the workspace billing day (tag each plan's role group).
    if (canNotify && dayOfMonth === ws.billing_day) {
      if (await claimNotification(env.DB, { workspaceId: ws.id, type: "billing_opened", period })) {
        const lines = await env.DB
          .prepare(
            `SELECT pl.id AS plan_id, pl.name AS plan_name, pl.monthly_amount AS amount, pl.discord_role_id AS role_id
             FROM plans pl
             WHERE pl.workspace_id = ? AND pl.active = 1
               AND EXISTS (SELECT 1 FROM subscriptions s WHERE s.plan_id = pl.id AND s.status = 'active')
             ORDER BY pl.id`
          )
          .bind(ws.id)
          .all<PlanOpenLine>();
        if (lines.results.length > 0) {
          await notifier.sendBillingOpened(env, channelId, period, lines.results, settings.billing_opened_template);
          summary.billingOpenedSent++;
        }
      }
    }

    // 3. Overdue reminders: one batched message per period that has overdue pending payments.
    if (canNotify) {
      const periods = await env.DB
        .prepare("SELECT DISTINCT period FROM payments WHERE workspace_id = ? AND status = 'pending'")
        .bind(ws.id)
        .all<{ period: string }>();
      for (const { period: pd } of periods.results) {
        if ((await sendOverdueForPeriod(env, ws.id, pd, notifier, { force: false, now })) > 0) summary.overdueSent++;
      }
    }

    // 4. Screenshot retention.
    summary.proofsDeleted += await runRetention(env, ws.id, settings.proof_retention_months, now);
  }

  return summary;
}

/**
 * Send the overdue reminder for ONE period as a single batched public message listing every
 * unpaid member (tag once + their plans + total), deduped per (ws, period). Cron uses
 * force=false (only fires when ≥1 member is past overdue_days, claim-then-send). The admin
 * resend uses force=true (lists ALL unpaid members regardless of overdue_days; clears the
 * dedup slot first so it always re-sends). Returns the number of members notified (0 = nothing
 * sent / already sent / can't notify).
 */
export async function sendOverdueForPeriod(
  env: Env,
  workspaceId: number,
  period: string,
  notifier: Notifier,
  opts: { force: boolean; now?: Date }
): Promise<number> {
  const wsRow = await env.DB.prepare("SELECT settings FROM workspaces WHERE id = ?").bind(workspaceId).first<{ settings: string }>();
  if (!wsRow) return 0;
  const settings = parseSettings(wsRow.settings);
  const channelId = settings.discord_billing_channel_id;
  if (!channelId || !env.DISCORD_BOT_TOKEN) return 0;
  const today = taipeiDate(opts.now ?? new Date());

  const rows = await env.DB
    .prepare(
      `SELECT u.id AS user_id, u.discord_id AS discord_id, u.display_name AS user_name,
              p.amount AS amount, p.due_date AS due_date, pl.name AS plan_name
       FROM payments p
       JOIN subscriptions s ON s.id = p.subscription_id
       JOIN users u ON u.id = s.user_id
       JOIN plans pl ON pl.id = s.plan_id
       WHERE p.workspace_id = ? AND p.period = ? AND p.status = 'pending'
       ORDER BY u.id, pl.id`
    )
    .bind(workspaceId, period)
    .all<{ user_id: number; discord_id: string | null; user_name: string; amount: number; due_date: string; plan_name: string }>();

  const byUser = new Map<number, OverduePerson & { overdue: boolean }>();
  for (const r of rows.results) {
    let e = byUser.get(r.user_id);
    if (!e) { e = { user_id: r.user_id, discord_id: r.discord_id, user_name: r.user_name, lines: [], total: 0, overdue: false }; byUser.set(r.user_id, e); }
    e.lines.push({ plan_name: r.plan_name, amount: r.amount });
    e.total += r.amount;
    if (daysBetween(r.due_date, today) >= settings.overdue_days) e.overdue = true;
  }

  const people = [...byUser.values()]
    .filter((p) => opts.force || p.overdue)
    .map(({ overdue, ...p }) => p);
  if (people.length === 0) return 0;

  if (opts.force) {
    await env.DB.prepare("DELETE FROM notification_logs WHERE workspace_id = ? AND type = 'overdue' AND period = ?")
      .bind(workspaceId, period).run();
  }
  if (!(await claimNotification(env.DB, { workspaceId, type: "overdue", period }))) return 0;
  await notifier.sendOverdue(env, channelId, period, people, settings.overdue_template);
  return people.length;
}
