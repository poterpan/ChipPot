import type { Env } from "../env";
import { parseSettings } from "../env";
import { taipeiPeriod, taipeiDate, taipeiDayOfMonth, daysBetween } from "./time";
import { ensurePeriodPayment } from "./billing";
import { runRetention } from "./retention";
import { claimNotification, type Notifier, type PlanOpenLine, type OverdueTarget } from "./notify";

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
  const today = taipeiDate(now);

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
          await notifier.sendBillingOpened(env, channelId, period, lines.results);
          summary.billingOpenedSent++;
        }
      }
    }

    // 3. Overdue reminders: still-pending payments past due_date by overdue_days.
    if (canNotify) {
      const pending = await env.DB
        .prepare(
          `SELECT p.subscription_id, p.period, p.amount, p.due_date,
                  u.discord_id, u.display_name AS user_name, pl.name AS plan_name
           FROM payments p
           JOIN subscriptions s ON s.id = p.subscription_id
           JOIN users u ON u.id = s.user_id
           JOIN plans pl ON pl.id = s.plan_id
           WHERE p.workspace_id = ? AND p.status = 'pending'`
        )
        .bind(ws.id)
        .all<OverdueTarget & { due_date: string }>();
      for (const o of pending.results) {
        if (daysBetween(o.due_date, today) >= settings.overdue_days) {
          if (await claimNotification(env.DB, { workspaceId: ws.id, type: "overdue", period: o.period, subscriptionId: o.subscription_id })) {
            await notifier.sendOverdue(env, channelId, o);
            summary.overdueSent++;
          }
        }
      }
    }

    // 4. Screenshot retention.
    summary.proofsDeleted += await runRetention(env, ws.id, settings.proof_retention_months, now);
  }

  return summary;
}
