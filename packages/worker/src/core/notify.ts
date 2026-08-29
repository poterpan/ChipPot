import type { Env } from "../env";
import { nowUtcIso } from "./time";

export interface PlanOpenLine {
  plan_id: number;
  plan_name: string;
  amount: number;
  role_id: string | null;
}
export interface OverduePerson {
  user_id: number;
  discord_id: string | null;
  user_name: string;
  lines: { plan_name: string; amount: number }[];
  total: number;
}

export type ReceiptKind = "reject" | "verify";
export interface ReceiptLine {
  plan_name: string;
  amount: number;
}
/** One member's one period — a receipt always answers "你這期那幾筆怎麼了". */
export interface ReceiptTarget {
  user_id: number;
  discord_id: string | null;
  user_name: string;
  period: string;
  lines: ReceiptLine[];
  total: number;
}

/**
 * Channel-agnostic notification sink (Discord impl in adapters/discord/notify.ts).
 *
 * CONTRACT: every method resolves to `true` only when the channel CONFIRMED delivery (a 2xx).
 * A false is what lets callers keep `sent` / `sent_at` / counts / audit outcomes honest — issue #43
 * is precisely that a swallowed non-2xx used to be reported to the admin as a delivered notice.
 * Implementations must not throw for a refused send; a transport error is a `false`, not an
 * exception, because the caller has already committed writes it cannot roll back.
 */
export interface Notifier {
  sendBillingOpened(env: Env, channelId: string, period: string, lines: PlanOpenLine[], template: string): Promise<boolean>;
  sendOverdue(env: Env, channelId: string, period: string, people: OverduePerson[], template: string): Promise<boolean>;
  /** Targeted nudge for members newly added to a period (e.g. after reconcile): @-mention them + pay button. */
  sendPaymentNudge(env: Env, channelId: string, workspaceId: number, period: string, people: OverduePerson[]): Promise<boolean>;
  /**
   * 審核結果回條: tell the member their submission was 退回 (with the reason) or 確認. Delivered in
   * the billing channel with an @-mention — the Discord adapter has no DM capability, and every
   * other member-facing message in this system already lands there.
   */
  sendPaymentReceipt(
    env: Env, channelId: string, workspaceId: number, kind: ReceiptKind,
    target: ReceiptTarget, reason: string | null
  ): Promise<boolean>;
}

export interface NotificationKey {
  workspaceId: number;
  type: "billing_opened" | "overdue" | "receipt" | "nudge";
  period: string;
  planId?: number;
  userId?: number;
  subscriptionId?: number;
  /**
   * Distinguishes two messages that share one entity. A bill's 退回 and 確認 are different
   * events on the same (period, user, subscription), so they must not share a slot; the daily
   * overdue reminder (#48) uses the Taipei business date as its event.
   * Omitted = '' = the entity-wide slot used by billing_opened / nudge.
   */
  event?: string;
}

/**
 * Claim a notification slot to guarantee at-most-once sending. Inserts a notification_logs
 * row; returns true if this caller won the slot (should send), false if already sent.
 * Uses NOT NULL DEFAULT 0 / '' sentinels so the UNIQUE actually dedupes (roadmap §4.1).
 */
export async function claimNotification(db: D1Database, k: NotificationKey): Promise<boolean> {
  return (await claimNotificationSlot(db, k)).won;
}

export interface NotificationSlot {
  /** True if this caller won the slot (should send); false if already claimed. */
  won: boolean;
  /** The claimed row's id (D1 last_row_id); null when `won` is false. */
  id: number | null;
}

/**
 * Claim with ownership: on a win the caller owns `id`, and a later release must go through
 * releaseSlot(id) — never a keyed DELETE — so a concurrent claim that replaced the row cannot have
 * its slot deleted by someone else's failed send (see sendOverdueForPeriod, #48 / Codex finding 2).
 */
export async function claimNotificationSlot(db: D1Database, k: NotificationKey): Promise<NotificationSlot> {
  const res = await db
    .prepare(
      `INSERT INTO notification_logs
        (workspace_id, type, period, plan_id, user_id, subscription_id, event, external_channel_type, sent_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'discord', ?)
       ON CONFLICT(workspace_id, type, period, plan_id, user_id, subscription_id, event) DO NOTHING`
    )
    .bind(k.workspaceId, k.type, k.period, k.planId ?? 0, k.userId ?? 0, k.subscriptionId ?? 0, k.event ?? "", nowUtcIso())
    .run();
  const won = (res.meta.changes ?? 0) > 0;
  return { won, id: won ? Number(res.meta.last_row_id) : null };
}

/** Release a slot by the row id the claim returned. Deleting by id (not by key) is what makes the
 * release ownership-safe: a stale id simply deletes nothing instead of a concurrent claim's row. */
export async function releaseSlot(db: D1Database, id: number): Promise<number> {
  const res = await db.prepare("DELETE FROM notification_logs WHERE id = ?").bind(id).run();
  return res.meta.changes ?? 0;
}

/**
 * A slot that may be released. billing_opened is excluded at the type level: that row is not a send
 * log, it IS the definition of "this period is open" (isBillingOpened, core/db.ts
 * listOpenPayablePeriods), so deleting it alone leaves pending bills standing in a period members
 * can no longer pay — a half retract. routes/admin.ts:250 409s the same request for the same
 * reason; releasing it is only ever correct as part of 收回本期開繳 (core/billing.ts).
 */
export type ReleasableKey = NotificationKey & { type: Exclude<NotificationKey["type"], "billing_opened"> };

/**
 * Give a claimed slot back so a genuinely new event can announce again. Two uses: an outbound send
 * that the Notifier did not confirm (never mute a bill forever because Discord hiccuped — the
 * release-on-false precedent is sendOverdueForPeriod in core/scheduled.ts), and an admin's explicit
 * 重發, which releases before claiming so the claim below always wins (also core/scheduled.ts, the
 * `force` branch). Omitting `event` releases every event of that entity. Returns rows deleted.
 */
export async function releaseNotification(db: D1Database, k: ReleasableKey): Promise<number> {
  const conds = ["workspace_id = ?", "type = ?", "period = ?", "plan_id = ?", "user_id = ?", "subscription_id = ?"];
  const binds: unknown[] = [k.workspaceId, k.type, k.period, k.planId ?? 0, k.userId ?? 0, k.subscriptionId ?? 0];
  if (k.event !== undefined) { conds.push("event = ?"); binds.push(k.event); }
  const res = await db.prepare(`DELETE FROM notification_logs WHERE ${conds.join(" AND ")}`).bind(...binds).run();
  return res.meta.changes ?? 0;
}

/**
 * Drop every receipt slot of ONE member's period. Called when the ball moves back to the member
 * (they re-submitted after a 退回) or when an admin undoes a verification: the next 退回/確認 of
 * those bills is then a new fact, not a retry, and must be announced again.
 */
export async function releaseReceiptSlots(
  db: D1Database, workspaceId: number, period: string, userId: number
): Promise<number> {
  const res = await db
    .prepare("DELETE FROM notification_logs WHERE workspace_id = ? AND type = 'receipt' AND period = ? AND user_id = ?")
    .bind(workspaceId, period, userId)
    .run();
  return res.meta.changes ?? 0;
}

/**
 * Whether the billing-opened notice has been recorded for this (workspace, period) — i.e. the
 * cron or an admin "發起繳費" has opened billing. Members may only self-pay once this is true.
 */
export async function isBillingOpened(db: D1Database, workspaceId: number, period: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 AS ok FROM notification_logs WHERE workspace_id = ? AND type = 'billing_opened' AND period = ? LIMIT 1")
    .bind(workspaceId, period)
    .first<{ ok: number }>();
  return !!row;
}
