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
        // Counted only on a confirmed send — the summary is what the daily run reports as done.
        // Note the deliberate divergence from initiateBillingOpened: the cron claims the marker
        // BEFORE knowing whether there are lines, because step 1 has already created this day's
        // bills and the cron will not revisit this period (it only fires on the billing day). An
        // unclaimed marker would strand those bills in an unpayable period; the admin path has a
        // preview promising no_plans and can simply be re-run, so it refuses to claim instead.
        if (lines.results.length > 0) {
          if (await notifier.sendBillingOpened(env, channelId, period, lines.results, settings.billing_opened_template)) {
            summary.billingOpenedSent++;
          }
        }
      }
    }

    // 3. Overdue reminders: one batched message per period with unpaid (pending/rejected) payments.
    if (canNotify) {
      const periods = await env.DB
        .prepare("SELECT DISTINCT period FROM payments WHERE workspace_id = ? AND status IN ('pending','rejected')")
        .bind(ws.id)
        .all<{ period: string }>();
      for (const { period: pd } of periods.results) {
        if ((await sendOverdueForPeriod(env, ws.id, pd, notifier, { force: false, now })).notified > 0) summary.overdueSent++;
      }
    }

    // 4. Screenshot retention.
    summary.proofsDeleted += await runRetention(env, ws.id, settings.proof_retention_months, now);
  }

  return summary;
}

export type OverdueOutcome = "sent" | "preview" | "no_channel" | "no_bot_token" | "none_due" | "already_sent" | "send_failed";

export interface OverdueResult {
  /** People actually messaged. Always 0 on a dry run — use `people.length` for the preview count. */
  notified: number;
  outcome: OverdueOutcome;
  /** The workspace's 逾期天數, so callers can spell out how force differs from the cron. */
  overdue_days: number;
  people: OverduePerson[];
}

/**
 * Send the overdue reminder for ONE period as a single batched public message listing every
 * unpaid member — pending OR rejected (a rejected submission still owes) — tagged once with
 * their plans + total, deduped per (ws, period, DAY): the daily cron keeps reminding every day
 * until the period has no unpaid bills left (#48).
 *
 * force=false (cron): only fires when ≥1 member is past overdue_days; claim-then-send. The slot
 * carries the Taipei business date, so a re-run the same day is deduped but the next day fires.
 * force=true (admin "催繳未繳成員"): lists ALL unpaid members regardless of overdue_days and clears
 * the dedup slot first so it always re-sends. The two lists genuinely differ, which is why the UI
 * must not call both "立即重發" — see the copy in views/PushStatus.tsx.
 * dryRun: compute the list and stop. Nothing is cleared, claimed or sent.
 * A refused send returns `send_failed` and releases the dedup slot it just claimed, so this period
 * can still be reminded (by the cron or by another 催繳) instead of going silent for good.
 */
export async function sendOverdueForPeriod(
  env: Env,
  workspaceId: number,
  period: string,
  notifier: Notifier,
  opts: { force: boolean; dryRun?: boolean; now?: Date; dayKey?: string }
): Promise<OverdueResult> {
  const bare = (outcome: OverdueOutcome, overdueDays = 0): OverdueResult =>
    ({ notified: 0, outcome, overdue_days: overdueDays, people: [] });

  const wsRow = await env.DB.prepare("SELECT settings FROM workspaces WHERE id = ?").bind(workspaceId).first<{ settings: string }>();
  if (!wsRow) return bare("no_channel");
  const settings = parseSettings(wsRow.settings);
  const channelId = settings.discord_billing_channel_id;
  if (!channelId) return bare("no_channel", settings.overdue_days);
  if (!env.DISCORD_BOT_TOKEN) return bare("no_bot_token", settings.overdue_days);
  const today = taipeiDate(opts.now ?? new Date());
  // The cron dedupes per business day; the admin force-resend keeps the entity-wide slot so it can
  // always fire (it deletes that whole-entity slot below). A caller-provided dayKey overrides the
  // date (tests / replay).
  const dayKey = opts.dayKey ?? today;

  const rows = await env.DB
    .prepare(
      `SELECT u.id AS user_id, u.discord_id AS discord_id, u.display_name AS user_name,
              p.amount AS amount, p.due_date AS due_date, pl.name AS plan_name
       FROM payments p
       JOIN subscriptions s ON s.id = p.subscription_id
       JOIN users u ON u.id = s.user_id
       JOIN plans pl ON pl.id = s.plan_id
       WHERE p.workspace_id = ? AND p.period = ? AND p.status IN ('pending','rejected')
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
  if (people.length === 0) return bare("none_due", settings.overdue_days);
  if (opts.dryRun) return { notified: 0, outcome: "preview", overdue_days: settings.overdue_days, people };

  if (opts.force) {
    // force = admin resend: clear the entity-wide slot so the claim below always wins. This
    // delete-then-claim isn't atomic, but force is an occasional single-admin dashboard action whose
    // button is disabled while in flight; the only risk is a duplicate message from two
    // truly-concurrent resends, which we accept (no DO/lock — YAGNI). Unlike the billing_opened
    // slot, the overdue row carries no "period is open" meaning, so a momentary gap is harmless.
    await env.DB.prepare("DELETE FROM notification_logs WHERE workspace_id = ? AND type = 'overdue' AND period = ?")
      .bind(workspaceId, period).run();
  }
  // The cron's slot is per day (dayKey); the admin's force resend reuses the '' entity-wide slot,
  // which is what the DELETE above just cleared.
  const event = opts.force ? "" : dayKey;
  if (!(await claimNotification(env.DB, { workspaceId, type: "overdue", period, event }))) {
    return { notified: 0, outcome: "already_sent", overdue_days: settings.overdue_days, people };
  }
  if (!(await notifier.sendOverdue(env, channelId, period, people, settings.overdue_template))) {
    // Give the slot back. Unlike billing_opened, this row carries no "period is open" meaning — it
    // says only "these people have already been reminded", and after a refused send nobody was.
    // Keeping it would mute this period's reminders permanently: every later claim (cron included)
    // would just lose and report already_sent, with no error surfacing anywhere. That is the exact
    // trap 收回本期開繳 avoids by deleting this row, so a failed send releases it for the same reason.
    // We can delete unconditionally: this call won the claim above, so the row is the one we wrote.
    await env.DB.prepare("DELETE FROM notification_logs WHERE workspace_id = ? AND type = 'overdue' AND period = ? AND event = ?")
      .bind(workspaceId, period, event).run();
    return { notified: 0, outcome: "send_failed", overdue_days: settings.overdue_days, people };
  }
  return { notified: people.length, outcome: "sent", overdue_days: settings.overdue_days, people };
}
