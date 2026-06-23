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

/** Channel-agnostic notification sink (Discord impl in adapters/discord/notify.ts). */
export interface Notifier {
  sendBillingOpened(env: Env, channelId: string, period: string, lines: PlanOpenLine[], template: string): Promise<void>;
  sendOverdue(env: Env, channelId: string, period: string, people: OverduePerson[], template: string): Promise<void>;
  /** Targeted nudge for members newly added to a period (e.g. after reconcile): @-mention them + pay button. */
  sendPaymentNudge(env: Env, channelId: string, workspaceId: number, period: string, people: OverduePerson[]): Promise<void>;
}

export interface NotificationKey {
  workspaceId: number;
  type: "billing_opened" | "overdue" | "receipt";
  period: string;
  planId?: number;
  userId?: number;
  subscriptionId?: number;
}

/**
 * Claim a notification slot to guarantee at-most-once sending. Inserts a notification_logs
 * row; returns true if this caller won the slot (should send), false if already sent.
 * Uses NOT NULL DEFAULT 0 sentinels so the UNIQUE actually dedupes (roadmap §4.1).
 */
export async function claimNotification(db: D1Database, k: NotificationKey): Promise<boolean> {
  const res = await db
    .prepare(
      `INSERT INTO notification_logs
        (workspace_id, type, period, plan_id, user_id, subscription_id, external_channel_type, sent_at)
       VALUES (?, ?, ?, ?, ?, ?, 'discord', ?)
       ON CONFLICT(workspace_id, type, period, plan_id, user_id, subscription_id) DO NOTHING`
    )
    .bind(k.workspaceId, k.type, k.period, k.planId ?? 0, k.userId ?? 0, k.subscriptionId ?? 0, nowUtcIso())
    .run();
  return (res.meta.changes ?? 0) > 0;
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
