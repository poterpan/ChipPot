import type { Env } from "../env";
import { parseSettings } from "../env";
import {
  claimNotification, releaseNotification, isBillingOpened,
  type Notifier, type NudgeKind, type OverduePerson,
} from "./notify";

export interface NudgeInput {
  workspaceId: number;
  period: string;
  userIds: number[];
  kind: NudgeKind;
  /**
   * The admin deliberately pressed 催繳 again: clear the per-user slot first so the claim below
   * wins (delete-then-claim, the same accepted pattern as core/scheduled.ts's `force` branch).
   * Automatic callers — CSV import, 新增訂閱, 重新同步 — never force, which is what stops the
   * repeated double-@ that P2-4 reported.
   */
  force?: boolean;
}

export interface NudgeResult {
  /** False = the period was never opened, so nobody can pay it and nothing was sent. */
  opened: boolean;
  notified: number;
  /** Already nudged for this period and not forced. */
  skipped: number;
  unbound: number;
  unbound_names: string[];
}

interface Row {
  user_id: number; discord_id: string | null; user_name: string;
  plan_name: string; amount: number;
}

/**
 * 個別／入職催繳 (C1, C2): @-mention specific members in the billing channel with what they still
 * owe for a period, plus the pay button. Deduped per (workspace, 'nudge', period, user), so the
 * same member is pinged at most once per period unless an admin explicitly re-sends.
 */
export async function sendMemberNudge(
  env: Env,
  o: NudgeInput,
  notifier: Notifier
): Promise<NudgeResult> {
  const empty: NudgeResult = { opened: false, notified: 0, skipped: 0, unbound: 0, unbound_names: [] };
  if (o.userIds.length === 0) return empty;

  // A member cannot act on a nudge for a period that isn't open (the pay button would answer
  // 「尚未開放」), so don't send one — and don't burn the slot either.
  if (!(await isBillingOpened(env.DB, o.workspaceId, o.period))) return empty;

  const wsRow = await env.DB.prepare("SELECT settings FROM workspaces WHERE id = ?")
    .bind(o.workspaceId).first<{ settings: string }>();
  if (!wsRow) return empty;
  const channelId = parseSettings(wsRow.settings).discord_billing_channel_id;
  // Same rule as core/receipt.ts and the cron: with no channel or no bot token we cannot send, so
  // we must not consume the dedup slot — otherwise configuring Discord later would arrive to
  // members who already count as nudged.
  if (!channelId || !env.DISCORD_BOT_TOKEN) return { ...empty, opened: true };

  const marks = o.userIds.map(() => "?").join(",");
  const rows = (await env.DB.prepare(
    `SELECT u.id AS user_id, u.discord_id AS discord_id, u.display_name AS user_name,
            pl.name AS plan_name, p.amount AS amount
     FROM payments p
     JOIN subscriptions s ON s.id = p.subscription_id
     JOIN users u ON u.id = s.user_id
     JOIN plans pl ON pl.id = s.plan_id
     WHERE p.workspace_id = ? AND p.period = ? AND p.status IN ('pending','rejected')
       AND s.status = 'active' AND u.id IN (${marks})
     ORDER BY u.id, pl.id`
  ).bind(o.workspaceId, o.period, ...o.userIds).all<Row>()).results;

  const byUser = new Map<number, OverduePerson>();
  for (const r of rows) {
    let e = byUser.get(r.user_id);
    if (!e) { e = { user_id: r.user_id, discord_id: r.discord_id, user_name: r.user_name, lines: [], total: 0 }; byUser.set(r.user_id, e); }
    e.lines.push({ plan_name: r.plan_name, amount: r.amount });
    e.total += r.amount;
  }

  const everyone = [...byUser.values()];
  // An unbound member can't be @-ed at all. Report them by name instead of silently sending to
  // a shorter list — that gap is exactly what made onboarding look like it worked (C9).
  const unboundPeople = everyone.filter((p) => !p.discord_id);
  const result: NudgeResult = {
    opened: true, notified: 0, skipped: 0,
    unbound: unboundPeople.length, unbound_names: unboundPeople.map((p) => p.user_name),
  };

  const winners: OverduePerson[] = [];
  for (const p of everyone) {
    if (!p.discord_id) continue;
    const key = { workspaceId: o.workspaceId, type: "nudge" as const, period: o.period, userId: p.user_id };
    if (o.force) await releaseNotification(env.DB, key);
    if (await claimNotification(env.DB, key)) winners.push(p); else result.skipped++;
  }
  if (winners.length === 0) return result;

  // The Notifier contract is "false = the channel did not confirm" (never a throw), but a caller
  // could still hand us an implementation that throws; both mean the same thing here.
  let ok = false;
  try {
    ok = await notifier.sendPaymentNudge(env, channelId, o.workspaceId, o.period, winners, o.kind);
  } catch (err) {
    // The caller's write (import / reconcile / nothing) already happened; a Discord hiccup must
    // neither fail it nor permanently mute these members.
    console.error("nudge send failed", err);
    ok = false;
  }
  if (ok) {
    result.notified = winners.length;
    return result;
  }
  for (const p of winners) {
    await releaseNotification(env.DB, {
      workspaceId: o.workspaceId, type: "nudge", period: o.period, userId: p.user_id,
    }).catch(() => 0);
  }
  return result;
}
