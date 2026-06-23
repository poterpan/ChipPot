import type { Env } from "../env";
import { nowUtcIso } from "./time";

export interface WorkspaceRow {
  id: number;
  name: string;
  owner_id: string;
  channel_type: string;
  billing_day: number;
  settings: string;
  created_at: string;
  updated_at: string;
}

export interface PlanRow {
  id: number;
  workspace_id: number;
  name: string;
  provider: string;
  monthly_amount: number;
  currency: string;
  billing_cycle: string;
  split_count: number | null;
  discord_role_id: string | null;
  active: number;
  created_at: string;
  updated_at: string;
}

export async function getWorkspace(
  db: D1Database,
  id: number
): Promise<WorkspaceRow | null> {
  return db
    .prepare("SELECT * FROM workspaces WHERE id = ?")
    .bind(id)
    .first<WorkspaceRow>();
}

/** Resolve the workspace whose settings.discord_guild_id matches (channel→workspace map). */
export async function getWorkspaceIdByGuild(
  db: D1Database,
  guildId: string
): Promise<number | null> {
  const row = await db
    .prepare("SELECT id FROM workspaces WHERE json_extract(settings, '$.discord_guild_id') = ?")
    .bind(guildId)
    .first<{ id: number }>();
  return row ? row.id : null;
}

export interface MemberRow {
  id: number;
  workspace_id: number;
  discord_id: string | null;
  display_name: string;
}

/** Find a workspace member by their Discord id. */
export async function getUserByDiscordId(
  db: D1Database,
  workspaceId: number,
  discordId: string
): Promise<MemberRow | null> {
  return db
    .prepare("SELECT id, workspace_id, discord_id, display_name FROM users WHERE workspace_id = ? AND discord_id = ?")
    .bind(workspaceId, discordId)
    .first<MemberRow>();
}

export async function getActivePlans(
  db: D1Database,
  workspaceId: number
): Promise<PlanRow[]> {
  const { results } = await db
    .prepare(
      "SELECT * FROM plans WHERE workspace_id = ? AND active = 1 ORDER BY id"
    )
    .bind(workspaceId)
    .all<PlanRow>();
  return results;
}

export interface SubscriptionChoice {
  id: number;
  plan_id: number;
  plan_name: string;
  amount: number;
}

/** Active subscriptions for a user (for the upload page's plan picker). */
export async function listActiveSubscriptions(
  db: D1Database,
  workspaceId: number,
  userId: number
): Promise<SubscriptionChoice[]> {
  const { results } = await db
    .prepare(
      `SELECT s.id AS id, s.plan_id AS plan_id, pl.name AS plan_name, pl.monthly_amount AS amount
       FROM subscriptions s JOIN plans pl ON pl.id = s.plan_id
       WHERE s.workspace_id = ? AND s.user_id = ? AND s.status = 'active'
       ORDER BY s.id`
    )
    .bind(workspaceId, userId)
    .all<SubscriptionChoice>();
  return results;
}

export interface ChannelTagChoice {
  id: number;
  name: string;
}

/** Active channel tags for a workspace (payment channel picker), sorted for display. */
export async function listActiveChannelTags(
  db: D1Database,
  workspaceId: number
): Promise<ChannelTagChoice[]> {
  const { results } = await db
    .prepare(
      "SELECT id, name FROM channel_tags WHERE workspace_id = ? AND active = 1 ORDER BY sort_order, id"
    )
    .bind(workspaceId)
    .all<ChannelTagChoice>();
  return results;
}

export interface SettleablePayment {
  id: number;
  amount: number;
  plan_name: string;
}

/**
 * Payments that a single submit can still settle (pending/rejected) for a user's active
 * subscriptions in a period. Used to show the per-plan breakdown + total before settling.
 */
export async function listSettleablePayments(
  db: D1Database,
  workspaceId: number,
  userId: number,
  period: string
): Promise<SettleablePayment[]> {
  const { results } = await db
    .prepare(
      `SELECT p.id AS id, p.amount AS amount, pl.name AS plan_name
       FROM payments p
       JOIN subscriptions s ON s.id = p.subscription_id
       JOIN plans pl ON pl.id = s.plan_id
       WHERE p.workspace_id = ? AND p.period = ? AND p.status IN ('pending','rejected')
         AND s.user_id = ? AND s.status = 'active'
       ORDER BY p.id`
    )
    .bind(workspaceId, period, userId)
    .all<SettleablePayment>();
  return results;
}

/**
 * Periods the member can pay right now = billing-opened AND still owed (pending/rejected) for
 * their active subs, oldest first. This intentionally includes a pre-opened *next* month, so once
 * an admin runs 發起繳費 members can register that period immediately (not only once the calendar
 * reaches it).
 */
export async function listOpenPayablePeriods(
  db: D1Database,
  workspaceId: number,
  userId: number
): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT DISTINCT p.period AS period
       FROM payments p
       JOIN subscriptions s ON s.id = p.subscription_id
       WHERE p.workspace_id = ? AND s.user_id = ? AND s.status = 'active'
         AND p.status IN ('pending','rejected')
         AND EXISTS (SELECT 1 FROM notification_logs n
                     WHERE n.workspace_id = p.workspace_id AND n.type = 'billing_opened' AND n.period = p.period)
       ORDER BY p.period`
    )
    .bind(workspaceId, userId)
    .all<{ period: string }>();
  return results.map((r) => r.period);
}

export interface UnboundUser {
  id: number;
  display_name: string;
}

/** Users in a workspace that have not yet linked a Discord account (for the self-bind select). */
export async function listUnboundUsers(
  db: D1Database,
  workspaceId: number
): Promise<UnboundUser[]> {
  const { results } = await db
    .prepare("SELECT id, display_name FROM users WHERE workspace_id = ? AND discord_id IS NULL ORDER BY id")
    .bind(workspaceId)
    .all<UnboundUser>();
  return results;
}

export interface BindResult {
  status: "ok" | "already_bound_other" | "name_taken" | "not_found";
  boundName?: string;
}

/**
 * Atomically link a Discord account to an unbound member. The guarded UPDATE only applies
 * when the target is still unbound AND this Discord account isn't already on someone, so two
 * people can't claim the same name and one account can't bind to two names.
 */
export async function bindDiscordId(
  env: Env,
  workspaceId: number,
  userId: number,
  discordId: string
): Promise<BindResult> {
  const now = nowUtcIso();
  const res = await env.DB
    .prepare(
      `UPDATE users SET discord_id = ?, updated_at = ?
       WHERE id = ? AND workspace_id = ? AND discord_id IS NULL
         AND NOT EXISTS (SELECT 1 FROM users WHERE workspace_id = ? AND discord_id = ?)`
    )
    .bind(discordId, now, userId, workspaceId, workspaceId, discordId)
    .run();

  if ((res.meta.changes ?? 0) === 1) {
    const u = await env.DB.prepare("SELECT display_name FROM users WHERE id = ?").bind(userId).first<{ display_name: string }>();
    return { status: "ok", boundName: u?.display_name };
  }

  // Didn't apply — diagnose precisely (messaging only; the guarded UPDATE above is the source
  // of truth). `boundName` here is whoever this Discord account is already linked to; if that
  // happens to be the target (a re-bind race), the "已綁定為 <name>" message is still correct.
  const other = await env.DB
    .prepare("SELECT display_name FROM users WHERE workspace_id = ? AND discord_id = ?")
    .bind(workspaceId, discordId)
    .first<{ display_name: string }>();
  if (other) return { status: "already_bound_other", boundName: other.display_name };

  const target = await env.DB
    .prepare("SELECT discord_id FROM users WHERE id = ? AND workspace_id = ?")
    .bind(userId, workspaceId)
    .first<{ discord_id: string | null }>();
  if (!target) return { status: "not_found" };
  if (target.discord_id !== null) return { status: "name_taken" };
  return { status: "not_found" };
}
