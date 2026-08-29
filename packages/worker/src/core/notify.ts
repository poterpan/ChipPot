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
}

export interface NotificationKey {
  workspaceId: number;
  type: "billing_opened" | "overdue" | "receipt";
  period: string;
  planId?: number;
  userId?: number;
  subscriptionId?: number;
  /** Distinguishes two messages that share one entity. '' = the whole-entity slot. */
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
