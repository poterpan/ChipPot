import type { Env } from "../env";
import { parseSettings } from "../env";
import {
  claimNotification, releaseNotification,
  type Notifier, type ReceiptKind, type ReceiptTarget,
} from "./notify";

export interface ReceiptRequest {
  workspaceId: number;
  kind: ReceiptKind;
  /** Bills to announce. Callers pass one member's rows: a 退回 is one bill, 一鍵全部驗證 is one
   *  member × one period. Anything outside the first row's (user, period) is dropped. */
  paymentIds: number[];
  reason?: string | null;
}

interface ReceiptRow {
  payment_id: number; subscription_id: number; period: string; amount: number;
  user_id: number; user_name: string; discord_id: string | null; plan_name: string;
}

/**
 * 審核結果回條 (P0-5): announce a 退回 / 確認 back to the member in the billing channel.
 *
 * Dedup is per (payment, event): 退回 and 確認 of one bill are two slots, and both are released
 * when the member re-submits (storage.settleUserPeriod) or an admin undoes a verification, so a
 * genuine second 退回 announces again while a retry never does. Returns the number of bills this
 * call actually announced (0 = nothing new to say, or nowhere to send).
 */
export async function announcePaymentReceipt(
  env: Env,
  req: ReceiptRequest,
  notifier: Notifier
): Promise<number> {
  if (req.paymentIds.length === 0) return 0;
  const wsRow = await env.DB.prepare("SELECT settings FROM workspaces WHERE id = ?")
    .bind(req.workspaceId).first<{ settings: string }>();
  if (!wsRow) return 0;
  const settings = parseSettings(wsRow.settings);
  const channelId = settings.discord_billing_channel_id;
  // Same rule as the cron (core/scheduled.ts): with no channel or no bot token we cannot send, so
  // we must not consume the dedup slot — otherwise configuring Discord later would arrive to a
  // bill that already counts as announced.
  if (!channelId || !env.DISCORD_BOT_TOKEN) return 0;
  // 退回 always notifies — that is the P0-5 death end. 確認 is opt-in: a busy month would post one
  // message per verified bill. Checked BEFORE any claim so switching it on later can still announce.
  if (req.kind === "verify" && !settings.receipt_notify_verified) return 0;

  const marks = req.paymentIds.map(() => "?").join(",");
  const rows = (await env.DB.prepare(
    `SELECT p.id AS payment_id, p.subscription_id AS subscription_id, p.period AS period, p.amount AS amount,
            s.user_id AS user_id, u.display_name AS user_name, u.discord_id AS discord_id, pl.name AS plan_name
     FROM payments p JOIN subscriptions s ON s.id = p.subscription_id
     JOIN users u ON u.id = s.user_id JOIN plans pl ON pl.id = s.plan_id
     WHERE p.workspace_id = ? AND p.id IN (${marks})
     ORDER BY p.id`
  ).bind(req.workspaceId, ...req.paymentIds).all<ReceiptRow>()).results;
  if (rows.length === 0) return 0;

  const head = rows[0]!;
  const mine = rows.filter((r) => r.user_id === head.user_id && r.period === head.period);

  // Claim per bill, send once: 一鍵全部驗證 verifies N rows and must produce ONE message, not N.
  const claimed: ReceiptRow[] = [];
  for (const r of mine) {
    const won = await claimNotification(env.DB, {
      workspaceId: req.workspaceId, type: "receipt", period: r.period,
      userId: r.user_id, subscriptionId: r.subscription_id, event: req.kind,
    });
    if (won) claimed.push(r);
  }
  if (claimed.length === 0) return 0;

  const target: ReceiptTarget = {
    user_id: head.user_id, discord_id: head.discord_id, user_name: head.user_name, period: head.period,
    lines: claimed.map((r) => ({ plan_name: r.plan_name, amount: r.amount })),
    total: claimed.reduce((s, r) => s + r.amount, 0),
  };

  // The Notifier contract is "false = the channel did not confirm" (never a throw), but a caller
  // could still hand us an implementation that throws; both mean the same thing here.
  let ok = false;
  try {
    ok = await notifier.sendPaymentReceipt(env, channelId, req.workspaceId, req.kind, target, req.reason ?? null);
  } catch (err) {
    console.error("receipt send failed", err);
    ok = false;
  }
  if (!ok) {
    // Hand the slots back: a Discord hiccup must not mute this bill's receipt forever. The admin
    // action itself already committed, so failing the request would be worse than a silent retry.
    for (const r of claimed) {
      await releaseNotification(env.DB, {
        workspaceId: req.workspaceId, type: "receipt", period: r.period,
        userId: r.user_id, subscriptionId: r.subscription_id, event: req.kind,
      }).catch(() => 0);
    }
    return 0;
  }
  return claimed.length;
}
