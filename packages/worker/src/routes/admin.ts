import type { Env } from "../env";
import { Router, type RouteCtx } from "../router";
import { errorResponse, json } from "../http";
import { parseSettings } from "../env";
import { nowUtcIso, taipeiDate, taipeiPeriod } from "../core/time";
import { issueUploadToken } from "../core/tokens";
import { writeAudit } from "../core/audit";
import { getPayment, verifyPayment, rejectPayment, overrideAmount, InvalidPaymentTransition } from "../core/payments";
import { ensureFirstPayment, initiateBillingOpened } from "../core/billing";
import { reconcilePeriod } from "../core/reconcile";
import { createChannelMessage, editChannelMessage } from "../adapters/discord/api";
import { payButtonRow } from "../adapters/discord/commands";
import { discordNotifier } from "../adapters/discord/notify";
import { parseRosterCsv, importRoster } from "../core/import";
import { sendOverdueForPeriod } from "../core/scheduled";
import { renderTemplate } from "../core/templates";

// Single-workspace MVP: default to the seeded workspace, overridable via ?workspace_id=.
const DEFAULT_WORKSPACE_ID = 1;
const UPLOAD_TOKEN_TTL_MS = 30 * 60 * 1000;

function wsId(_ctx: RouteCtx): number {
  // Single-workspace MVP: always the default workspace (not caller-controlled).
  // Multi-workspace will resolve the allowed workspace from ctx.identity.
  return DEFAULT_WORKSPACE_ID;
}

async function tagBelongsToWorkspace(env: Env, ws: number, tagId: number): Promise<boolean> {
  const row = await env.DB.prepare("SELECT 1 AS ok FROM channel_tags WHERE id = ? AND workspace_id = ?")
    .bind(tagId, ws).first<{ ok: number }>();
  return !!row;
}

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
function actorOf(ctx: RouteCtx): string {
  return ctx.identity?.email ?? "system";
}
async function readJson<T>(req: Request): Promise<T | null> {
  try {
    return (await req.json()) as T;
  } catch {
    return null;
  }
}

// ── Workspace / settings ─────────────────────────────────────────────────────

async function getWorkspace(_req: Request, env: Env, ctx: RouteCtx): Promise<Response> {
  const row = await env.DB.prepare("SELECT * FROM workspaces WHERE id = ?").bind(wsId(ctx))
    .first<{ id: number; name: string; billing_day: number; settings: string }>();
  if (!row) return errorResponse(404, "not found");
  return json({ workspace: { ...row, settings: parseSettings(row.settings) } });
}

async function updateWorkspace(req: Request, env: Env, ctx: RouteCtx): Promise<Response> {
  const ws = wsId(ctx);
  const before = await env.DB.prepare("SELECT billing_day, settings FROM workspaces WHERE id = ?")
    .bind(ws).first<{ billing_day: number; settings: string }>();
  if (!before) return errorResponse(404, "not found");
  const b = await readJson<{ billing_day?: number; settings?: Record<string, unknown> }>(req) ?? {};
  if (b.billing_day !== undefined && (!Number.isInteger(b.billing_day) || b.billing_day < 1 || b.billing_day > 28)) {
    return errorResponse(400, "billing_day must be 1..28");
  }
  let merged: string;
  try {
    merged = JSON.stringify(parseSettings(JSON.stringify({ ...parseSettings(before.settings), ...(b.settings ?? {}) })));
  } catch (e) {
    return errorResponse(400, (e as Error).message);
  }
  const billingDay = b.billing_day ?? before.billing_day;
  await env.DB.prepare("UPDATE workspaces SET billing_day = ?, settings = ?, updated_at = ? WHERE id = ?")
    .bind(billingDay, merged, nowUtcIso(), ws).run();
  await writeAudit(env.DB, { workspaceId: ws, actor: actorOf(ctx), action: "workspace.update", entityType: "workspace", entityId: ws, before, after: { billing_day: billingDay, settings: merged } });
  return json({ ok: true });
}

// ── Reconcile ────────────────────────────────────────────────────────────────

async function reconcile(_req: Request, env: Env, ctx: RouteCtx): Promise<Response> {
  const period = ctx.url.searchParams.get("period") ?? taipeiPeriod();
  return json(await reconcilePeriod(env.DB, wsId(ctx), period));
}

// ── Manual 發起繳費 (confirm amounts + open billing) ──────────────────────────

async function billingInitiate(req: Request, env: Env, ctx: RouteCtx): Promise<Response> {
  const ws = wsId(ctx);
  const b = await readJson<{ period?: string; amounts?: { plan_id: number; amount: number }[] }>(req);
  const period = b?.period ?? taipeiPeriod();
  if (!PERIOD_RE.test(period)) return errorResponse(400, "period must be YYYY-MM");
  if (!Array.isArray(b?.amounts)) return errorResponse(400, "amounts is required");
  for (const a of b!.amounts) {
    if (!a || typeof a !== "object" || !Number.isInteger(a.plan_id) || !Number.isInteger(a.amount) || a.amount < 0) {
      return errorResponse(400, "each amount needs an integer plan_id and non-negative amount");
    }
  }
  const r = await initiateBillingOpened(
    env, ws, period, { amounts: b!.amounts }, actorOf(ctx), discordNotifier
  );
  return json({ ok: true, sent: r.sent, updated_plans: r.updatedPlans, updated_payments: r.updatedPayments });
}

const NOTIF_TYPES = ["billing_opened", "overdue"] as const;

async function notificationsStatus(_req: Request, env: Env, ctx: RouteCtx): Promise<Response> {
  const ws = wsId(ctx);
  const period = ctx.url.searchParams.get("period") ?? taipeiPeriod();
  if (!PERIOD_RE.test(period)) return errorResponse(400, "period must be YYYY-MM");
  const row = (type: string) =>
    env.DB.prepare("SELECT sent_at FROM notification_logs WHERE workspace_id = ? AND type = ? AND period = ? ORDER BY sent_at DESC LIMIT 1")
      .bind(ws, type, period).first<{ sent_at: string }>();
  return json({ billing_opened: await row("billing_opened"), overdue: await row("overdue") });
}

async function notificationsResend(req: Request, env: Env, ctx: RouteCtx): Promise<Response> {
  const ws = wsId(ctx);
  const b = await readJson<{ type?: string; period?: string }>(req);
  if (b?.period !== undefined && typeof b.period !== "string") return errorResponse(400, "period must be YYYY-MM");
  const period = b?.period ?? taipeiPeriod();
  if (!b?.type || !NOTIF_TYPES.includes(b.type as any)) return errorResponse(400, "type must be billing_opened or overdue");
  if (!PERIOD_RE.test(period)) return errorResponse(400, "period must be YYYY-MM");
  let result: { sent?: boolean; count?: number };
  if (b.type === "billing_opened") {
    const r = await initiateBillingOpened(env, ws, period, { amounts: [] }, actorOf(ctx), discordNotifier, { force: true });
    result = { sent: r.sent };
  } else {
    const count = await sendOverdueForPeriod(env, ws, period, discordNotifier, { force: true });
    result = { count };
  }
  await writeAudit(env.DB, { workspaceId: ws, actor: actorOf(ctx), action: "notification.resend", entityType: "workspace", entityId: ws, after: { type: b.type, period, ...result } });
  return json({ ok: true, ...result });
}

async function notificationsReset(req: Request, env: Env, ctx: RouteCtx): Promise<Response> {
  const ws = wsId(ctx);
  const b = await readJson<{ type?: string; period?: string }>(req);
  if (b?.period !== undefined && typeof b.period !== "string") return errorResponse(400, "period must be YYYY-MM");
  const period = b?.period ?? taipeiPeriod();
  if (!b?.type || !NOTIF_TYPES.includes(b.type as any)) return errorResponse(400, "type must be billing_opened or overdue");
  if (!PERIOD_RE.test(period)) return errorResponse(400, "period must be YYYY-MM");
  const res = await env.DB.prepare("DELETE FROM notification_logs WHERE workspace_id = ? AND type = ? AND period = ?")
    .bind(ws, b.type, period).run();
  const deleted = res.meta.changes ?? 0;
  await writeAudit(env.DB, { workspaceId: ws, actor: actorOf(ctx), action: "notification.reset", entityType: "workspace", entityId: ws, after: { type: b.type, period, deleted } });
  return json({ ok: true, deleted });
}

async function membersImport(req: Request, env: Env, ctx: RouteCtx): Promise<Response> {
  const ws = wsId(ctx);
  let csv: string | null = null;
  let startDate: string | undefined;
  const ct = req.headers.get("content-type") ?? "";
  if (ct.includes("multipart/form-data")) {
    let form: FormData;
    try { form = await req.formData(); } catch { return errorResponse(400, "expected a multipart form"); }
    const f = form.get("file");
    if (f && typeof f !== "string") csv = await (f as Blob).text();
    const sd = form.get("start_date");
    if (typeof sd === "string" && sd.trim()) startDate = sd.trim();
  } else {
    const b = await readJson<{ csv?: unknown; start_date?: unknown }>(req);
    if (typeof b?.csv === "string") csv = b.csv;
    if (typeof b?.start_date === "string" && b.start_date.trim()) startDate = b.start_date.trim();
  }
  if (!csv) return errorResponse(400, "csv is required");
  if (startDate && !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) return errorResponse(400, "start_date must be YYYY-MM-DD");
  const start = startDate ?? `${taipeiPeriod()}-01`;
  const summary = await importRoster(env, ws, parseRosterCsv(csv), { startDate: start });
  await writeAudit(env.DB, { workspaceId: ws, actor: actorOf(ctx), action: "roster.import", entityType: "workspace", entityId: ws, after: summary });
  return json({ ok: true, summary });
}

// ── Users ────────────────────────────────────────────────────────────────────

async function listUsers(_req: Request, env: Env, ctx: RouteCtx): Promise<Response> {
  const { results } = await env.DB
    .prepare("SELECT * FROM users WHERE workspace_id = ? ORDER BY id")
    .bind(wsId(ctx)).all();
  return json({ users: results });
}

async function createUser(req: Request, env: Env, ctx: RouteCtx): Promise<Response> {
  const b = await readJson<{ display_name?: string; discord_id?: string; email?: string; note?: string }>(req);
  if (!b?.display_name) return errorResponse(400, "display_name is required");
  const now = nowUtcIso();
  const res = await env.DB
    .prepare(`INSERT INTO users (workspace_id, discord_id, display_name, email, note, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(wsId(ctx), b.discord_id ?? null, b.display_name, b.email ?? null, b.note ?? null, now, now)
    .run();
  const id = res.meta.last_row_id as number;
  await writeAudit(env.DB, { workspaceId: wsId(ctx), actor: actorOf(ctx), action: "user.create", entityType: "user", entityId: id, after: b });
  return json({ id }, { status: 201 });
}

async function updateUser(req: Request, env: Env, ctx: RouteCtx): Promise<Response> {
  const id = Number(ctx.params.id);
  const before = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(id).first();
  if (!before) return errorResponse(404, "not found");
  const b = await readJson<{ display_name?: string; discord_id?: string; email?: string; note?: string }>(req) ?? {};
  const discordId = typeof b.discord_id === "string" && b.discord_id.trim() ? b.discord_id.trim() : null;
  if (discordId) {
    const clash = await env.DB.prepare("SELECT id FROM users WHERE workspace_id = ? AND discord_id = ? AND id <> ?")
      .bind(wsId(ctx), discordId, id).first<{ id: number }>();
    if (clash) return errorResponse(400, "此 Discord ID 已綁定其他成員");
  }
  try {
    await env.DB.prepare(
      `UPDATE users SET display_name = COALESCE(?, display_name), discord_id = ?, email = ?, note = ?, updated_at = ? WHERE id = ?`
    ).bind(b.display_name ?? null, discordId, b.email ?? null, b.note ?? null, nowUtcIso(), id).run();
  } catch (e) {
    // Belt for the precheck's TOCTOU race: a concurrent bind to the same discord_id.
    if (String((e as Error).message).includes("UNIQUE")) return errorResponse(400, "此 Discord ID 已綁定其他成員");
    throw e;
  }
  const after = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(id).first();
  await writeAudit(env.DB, { workspaceId: wsId(ctx), actor: actorOf(ctx), action: "user.update", entityType: "user", entityId: id, before, after });
  return json({ ok: true });
}

// ── Plans ──────────────────────────────────────────────────────────────────

async function listPlans(_req: Request, env: Env, ctx: RouteCtx): Promise<Response> {
  const { results } = await env.DB.prepare("SELECT * FROM plans WHERE workspace_id = ? ORDER BY id").bind(wsId(ctx)).all();
  return json({ plans: results });
}

async function createPlan(req: Request, env: Env, ctx: RouteCtx): Promise<Response> {
  const b = await readJson<{ name?: string; provider?: string; monthly_amount?: number; discord_role_id?: string }>(req);
  if (!b?.name || !b.provider || typeof b.monthly_amount !== "number") {
    return errorResponse(400, "name, provider, monthly_amount are required");
  }
  const now = nowUtcIso();
  const res = await env.DB.prepare(
    `INSERT INTO plans (workspace_id, name, provider, monthly_amount, discord_role_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(wsId(ctx), b.name, b.provider, b.monthly_amount, b.discord_role_id ?? null, now, now).run();
  const id = res.meta.last_row_id as number;
  await writeAudit(env.DB, { workspaceId: wsId(ctx), actor: actorOf(ctx), action: "plan.create", entityType: "plan", entityId: id, after: b });
  return json({ id }, { status: 201 });
}

async function updatePlan(req: Request, env: Env, ctx: RouteCtx): Promise<Response> {
  const id = Number(ctx.params.id);
  const before = await env.DB.prepare("SELECT * FROM plans WHERE id = ?").bind(id).first();
  if (!before) return errorResponse(404, "not found");
  const b = await readJson<{ name?: string; provider?: string; monthly_amount?: number; discord_role_id?: string; active?: number }>(req) ?? {};
  await env.DB.prepare(
    `UPDATE plans SET name = COALESCE(?, name), provider = COALESCE(?, provider), monthly_amount = COALESCE(?, monthly_amount),
       discord_role_id = ?, active = COALESCE(?, active), updated_at = ? WHERE id = ?`
  ).bind(b.name ?? null, b.provider ?? null, b.monthly_amount ?? null, b.discord_role_id ?? null, b.active ?? null, nowUtcIso(), id).run();
  const after = await env.DB.prepare("SELECT * FROM plans WHERE id = ?").bind(id).first();
  await writeAudit(env.DB, { workspaceId: wsId(ctx), actor: actorOf(ctx), action: "plan.update", entityType: "plan", entityId: id, before, after });
  return json({ ok: true });
}

// ── Subscriptions ─────────────────────────────────────────────────────────────

async function listSubscriptions(_req: Request, env: Env, ctx: RouteCtx): Promise<Response> {
  const { results } = await env.DB.prepare(
    `SELECT s.*, u.display_name AS user_name, pl.name AS plan_name
     FROM subscriptions s JOIN users u ON u.id = s.user_id JOIN plans pl ON pl.id = s.plan_id
     WHERE s.workspace_id = ? ORDER BY s.id`
  ).bind(wsId(ctx)).all();
  return json({ subscriptions: results });
}

async function createSubscription(req: Request, env: Env, ctx: RouteCtx): Promise<Response> {
  const b = await readJson<{ user_id?: number; plan_id?: number; start_date?: string; billing_day?: number; custom_cycle?: number }>(req);
  if (!b?.user_id || !b.plan_id || !b.start_date) {
    return errorResponse(400, "user_id, plan_id, start_date are required");
  }
  const ws = wsId(ctx);
  const wsRow = await env.DB.prepare("SELECT billing_day FROM workspaces WHERE id = ?").bind(ws).first<{ billing_day: number }>();
  const billingDay = b.billing_day ?? wsRow?.billing_day ?? 5;
  const now = nowUtcIso();
  const res = await env.DB.prepare(
    `INSERT INTO subscriptions (workspace_id, user_id, plan_id, start_date, billing_day, custom_cycle, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(ws, b.user_id, b.plan_id, b.start_date, billingDay, b.custom_cycle ?? 0, now, now).run();
  const id = res.meta.last_row_id as number;
  const first = await ensureFirstPayment(env.DB, id); // spec §8: create first period payment now
  await writeAudit(env.DB, { workspaceId: ws, actor: actorOf(ctx), action: "subscription.create", entityType: "subscription", entityId: id, after: { ...b, first_payment_id: first.paymentId } });
  return json({ id, first_payment_id: first.paymentId }, { status: 201 });
}

async function updateSubscription(req: Request, env: Env, ctx: RouteCtx): Promise<Response> {
  const id = Number(ctx.params.id);
  const before = await env.DB.prepare("SELECT * FROM subscriptions WHERE id = ?").bind(id).first();
  if (!before) return errorResponse(404, "not found");
  const b = await readJson<{ status?: string; start_date?: string; billing_day?: number; custom_cycle?: number }>(req) ?? {};
  if (b.status && !["active", "paused", "cancelled"].includes(b.status)) {
    return errorResponse(400, "invalid status");
  }
  await env.DB.prepare(
    `UPDATE subscriptions SET status = COALESCE(?, status), start_date = COALESCE(?, start_date),
       billing_day = COALESCE(?, billing_day), custom_cycle = COALESCE(?, custom_cycle), updated_at = ? WHERE id = ?`
  ).bind(b.status ?? null, b.start_date ?? null, b.billing_day ?? null, b.custom_cycle ?? null, nowUtcIso(), id).run();
  const after = await env.DB.prepare("SELECT * FROM subscriptions WHERE id = ?").bind(id).first();
  await writeAudit(env.DB, { workspaceId: wsId(ctx), actor: actorOf(ctx), action: "subscription.update", entityType: "subscription", entityId: id, before, after });
  return json({ ok: true });
}

// ── Channel tags ───────────────────────────────────────────────────────────

async function listChannelTags(_req: Request, env: Env, ctx: RouteCtx): Promise<Response> {
  const { results } = await env.DB.prepare("SELECT * FROM channel_tags WHERE workspace_id = ? ORDER BY sort_order, id").bind(wsId(ctx)).all();
  return json({ channel_tags: results });
}

async function createChannelTag(req: Request, env: Env, ctx: RouteCtx): Promise<Response> {
  const b = await readJson<{ name?: string; type?: string; sort_order?: number }>(req);
  if (!b?.name) return errorResponse(400, "name is required");
  const res = await env.DB.prepare(
    `INSERT INTO channel_tags (workspace_id, name, type, sort_order, created_at) VALUES (?, ?, ?, ?, ?)`
  ).bind(wsId(ctx), b.name, b.type ?? null, b.sort_order ?? 0, nowUtcIso()).run();
  const id = res.meta.last_row_id as number;
  await writeAudit(env.DB, { workspaceId: wsId(ctx), actor: actorOf(ctx), action: "channel_tag.create", entityType: "channel_tag", entityId: id, after: b });
  return json({ id }, { status: 201 });
}

async function updateChannelTag(req: Request, env: Env, ctx: RouteCtx): Promise<Response> {
  const id = Number(ctx.params.id);
  const before = await env.DB.prepare("SELECT * FROM channel_tags WHERE id = ?").bind(id).first();
  if (!before) return errorResponse(404, "not found");
  const b = await readJson<{ name?: string; type?: string; active?: number; sort_order?: number }>(req) ?? {};
  await env.DB.prepare(
    `UPDATE channel_tags SET name = COALESCE(?, name), type = COALESCE(?, type),
       active = COALESCE(?, active), sort_order = COALESCE(?, sort_order) WHERE id = ?`
  ).bind(b.name ?? null, b.type ?? null, b.active ?? null, b.sort_order ?? null, id).run();
  const after = await env.DB.prepare("SELECT * FROM channel_tags WHERE id = ?").bind(id).first();
  await writeAudit(env.DB, { workspaceId: wsId(ctx), actor: actorOf(ctx), action: "channel_tag.update", entityType: "channel_tag", entityId: id, before, after });
  return json({ ok: true });
}

// ── Payments ─────────────────────────────────────────────────────────────────

async function listPayments(_req: Request, env: Env, ctx: RouteCtx): Promise<Response> {
  const ws = wsId(ctx);
  const period = ctx.url.searchParams.get("period");
  const status = ctx.url.searchParams.get("status");
  const conds = ["p.workspace_id = ?"];
  const binds: unknown[] = [ws];
  if (period) { conds.push("p.period = ?"); binds.push(period); }
  if (status) { conds.push("p.status = ?"); binds.push(status); }
  const { results } = await env.DB.prepare(
    `SELECT p.*, u.display_name AS user_name, pl.name AS plan_name,
            ct.name AS channel_tag_name, dct.name AS declared_channel_tag_name
     FROM payments p
     JOIN subscriptions s ON s.id = p.subscription_id
     JOIN users u ON u.id = s.user_id
     JOIN plans pl ON pl.id = s.plan_id
     LEFT JOIN channel_tags ct ON ct.id = p.verified_channel_tag_id
     LEFT JOIN channel_tags dct ON dct.id = p.declared_channel_tag_id
     WHERE ${conds.join(" AND ")}
     ORDER BY CASE p.status WHEN 'paid' THEN 0 WHEN 'rejected' THEN 1 WHEN 'verified' THEN 2 ELSE 3 END, p.id DESC`
  ).bind(...binds).all();
  return json({ payments: results });
}

async function verifyPaymentHandler(req: Request, env: Env, ctx: RouteCtx): Promise<Response> {
  const id = Number(ctx.params.id);
  const before = await getPayment(env.DB, id);
  if (!before || before.workspace_id !== wsId(ctx)) return errorResponse(404, "not found");
  const b = await readJson<{ verified_channel_tag_id?: number }>(req) ?? {};
  // Default the verified channel to the user's declared channel when the admin doesn't override.
  const tagId = b.verified_channel_tag_id ?? before.declared_channel_tag_id ?? null;
  if (tagId != null && !(await tagBelongsToWorkspace(env, before.workspace_id, tagId))) {
    return errorResponse(400, "invalid channel tag");
  }
  try {
    const after = await verifyPayment(env.DB, id, { verifiedBy: actorOf(ctx), verifiedChannelTagId: tagId });
    await writeAudit(env.DB, { workspaceId: before.workspace_id, actor: actorOf(ctx), action: "payment.verify", entityType: "payment", entityId: id, before, after });
    return json({ ok: true, payment: after });
  } catch (e) {
    if (e instanceof InvalidPaymentTransition) return errorResponse(409, e.message);
    throw e;
  }
}

async function rejectPaymentHandler(req: Request, env: Env, ctx: RouteCtx): Promise<Response> {
  const id = Number(ctx.params.id);
  const before = await getPayment(env.DB, id);
  if (!before) return errorResponse(404, "not found");
  const b = await readJson<{ rejected_reason?: string }>(req) ?? {};
  try {
    const after = await rejectPayment(env.DB, id, { rejectedReason: b.rejected_reason ?? null, verifiedBy: actorOf(ctx) });
    await writeAudit(env.DB, { workspaceId: before.workspace_id, actor: actorOf(ctx), action: "payment.reject", entityType: "payment", entityId: id, before, after });
    return json({ ok: true, payment: after });
  } catch (e) {
    if (e instanceof InvalidPaymentTransition) return errorResponse(409, e.message);
    throw e;
  }
}

async function overrideAmountHandler(req: Request, env: Env, ctx: RouteCtx): Promise<Response> {
  const id = Number(ctx.params.id);
  const before = await getPayment(env.DB, id);
  if (!before) return errorResponse(404, "not found");
  const b = await readJson<{ amount?: number }>(req);
  if (typeof b?.amount !== "number" || !Number.isInteger(b.amount) || b.amount < 0) {
    return errorResponse(400, "integer amount required");
  }
  const after = await overrideAmount(env.DB, id, b.amount);
  await writeAudit(env.DB, { workspaceId: before.workspace_id, actor: actorOf(ctx), action: "amount.override", entityType: "payment", entityId: id, before: { amount: before.amount }, after: { amount: after.amount } });
  return json({ ok: true, payment: after });
}

async function manualPayment(req: Request, env: Env, ctx: RouteCtx): Promise<Response> {
  const b = await readJson<{
    subscription_id?: number; period?: string; amount?: number; status?: string;
    verified_channel_tag_id?: number; payment_note?: string;
  }>(req);
  if (!b?.subscription_id || !b.period) return errorResponse(400, "subscription_id and period are required");
  if (!PERIOD_RE.test(b.period)) return errorResponse(400, "period must be YYYY-MM");
  const status = b.status ?? "verified";
  if (!["pending", "paid", "verified", "rejected"].includes(status)) return errorResponse(400, "invalid status");
  if (b.amount !== undefined && (!Number.isInteger(b.amount) || b.amount < 0)) {
    return errorResponse(400, "amount must be a non-negative integer");
  }
  const ws = wsId(ctx);
  if (b.verified_channel_tag_id != null && !(await tagBelongsToWorkspace(env, ws, b.verified_channel_tag_id))) {
    return errorResponse(400, "invalid channel tag");
  }
  const sub = await env.DB.prepare(
    `SELECT s.billing_day AS billing_day, pl.monthly_amount AS amount FROM subscriptions s JOIN plans pl ON pl.id = s.plan_id WHERE s.id = ? AND s.workspace_id = ?`
  ).bind(b.subscription_id, ws).first<{ billing_day: number; amount: number }>();
  if (!sub) return errorResponse(400, "invalid subscription");
  const amount = b.amount ?? sub.amount;
  const now = nowUtcIso();
  const period_start = `${b.period}-01`;
  const [y, m] = b.period.split("-").map(Number);
  const period_end = `${b.period}-${String(new Date(Date.UTC(y!, m!, 0)).getUTCDate()).padStart(2, "0")}`;
  const due_date = `${b.period}-${String(sub.billing_day).padStart(2, "0")}`;
  const verifiedAt = status === "verified" ? now : null;
  const verifiedBy = status === "verified" ? actorOf(ctx) : null;
  const paidAt = status === "paid" || status === "verified" ? now : null;
  await env.DB.prepare(
    `INSERT INTO payments (workspace_id, subscription_id, period, period_start, period_end, due_date, amount, status,
        verified_channel_tag_id, payment_note, source, paid_at, verified_by, verified_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'admin_manual', ?, ?, ?, ?, ?)
     ON CONFLICT(subscription_id, period) DO UPDATE SET
        amount = excluded.amount, status = excluded.status,
        verified_channel_tag_id = excluded.verified_channel_tag_id,
        payment_note = excluded.payment_note, source = 'admin_manual',
        paid_at = excluded.paid_at, verified_by = excluded.verified_by,
        verified_at = excluded.verified_at, updated_at = excluded.updated_at`
  ).bind(ws, b.subscription_id, b.period, period_start, period_end, due_date, amount, status,
    b.verified_channel_tag_id ?? null, b.payment_note ?? null, paidAt, verifiedBy, verifiedAt, now, now).run();
  const row = await env.DB.prepare("SELECT id FROM payments WHERE subscription_id = ? AND period = ?").bind(b.subscription_id, b.period).first<{ id: number }>();
  await writeAudit(env.DB, { workspaceId: ws, actor: actorOf(ctx), action: "payment.manual", entityType: "payment", entityId: row!.id, after: { ...b, amount, status } });
  return json({ id: row!.id }, { status: 201 });
}

async function deleteProof(_req: Request, env: Env, ctx: RouteCtx): Promise<Response> {
  const id = Number(ctx.params.id);
  const p = await getPayment(env.DB, id);
  if (!p) return errorResponse(404, "not found");
  if (p.screenshot_key) await env.BUCKET.delete(p.screenshot_key);
  await env.DB.prepare("UPDATE payments SET screenshot_key = NULL, proof_deleted_at = ?, updated_at = ? WHERE id = ?")
    .bind(taipeiDate(), nowUtcIso(), id).run();
  await writeAudit(env.DB, { workspaceId: p.workspace_id, actor: actorOf(ctx), action: "proof.delete", entityType: "payment", entityId: id, before: { screenshot_key: p.screenshot_key } });
  return json({ ok: true });
}

// ── One-time upload link ─────────────────────────────────────────────────────

async function createUploadLink(req: Request, env: Env, ctx: RouteCtx): Promise<Response> {
  const b = await readJson<{ user_id?: number; period?: string; subscription_id?: number }>(req);
  if (!b?.user_id || !b.period) return errorResponse(400, "user_id and period are required");
  const ws = wsId(ctx);
  const user = await env.DB.prepare("SELECT id FROM users WHERE id = ? AND workspace_id = ?").bind(b.user_id, ws).first();
  if (!user) return errorResponse(400, "invalid user");
  const { raw, expiresAt } = await issueUploadToken(env.DB, {
    workspaceId: ws, userId: b.user_id, period: b.period, subscriptionId: b.subscription_id ?? null,
    ttlMs: UPLOAD_TOKEN_TTL_MS,
  });
  await writeAudit(env.DB, { workspaceId: ws, actor: actorOf(ctx), action: "upload_link.create", entityType: "user", entityId: b.user_id, after: { period: b.period, subscription_id: b.subscription_id ?? null, expires_at: expiresAt } });
  const path = `/u/${raw}`;
  const webOrigin = (env.WEB_ORIGIN ?? "").replace(/\/$/, "");
  return json({ token: raw, path, url: `${webOrigin}${path}`, expires_at: expiresAt }, { status: 201 });
}

// ── Discord persistent payment message (spec §11.4) ──────────────────────────

async function discordPaymentMessage(_req: Request, env: Env, ctx: RouteCtx): Promise<Response> {
  const ws = wsId(ctx);
  const row = await env.DB.prepare("SELECT settings FROM workspaces WHERE id = ?").bind(ws).first<{ settings: string }>();
  if (!row) return errorResponse(404, "not found");
  const settings = parseSettings(row.settings);
  const channelId = settings.discord_billing_channel_id;
  if (!channelId) return errorResponse(400, "discord_billing_channel_id is not set");
  if (!env.DISCORD_BOT_TOKEN) return errorResponse(400, "bot token not configured");

  const body = {
    content: renderTemplate(settings.payment_message_template, { period: taipeiPeriod() }),
    components: [payButtonRow(ws)],
  };
  let messageId = settings.discord_payment_message_id;
  let ok = false;
  if (messageId) ok = await editChannelMessage(env.DISCORD_BOT_TOKEN, channelId, messageId, body);
  if (!ok) {
    messageId = (await createChannelMessage(env.DISCORD_BOT_TOKEN, channelId, body)) ?? "";
    ok = !!messageId;
  }
  if (!ok) return errorResponse(502, "failed to post Discord message");

  await env.DB.prepare("UPDATE workspaces SET settings = json_set(settings, '$.discord_payment_message_id', ?), updated_at = ? WHERE id = ?")
    .bind(messageId, nowUtcIso(), ws).run();
  await writeAudit(env.DB, { workspaceId: ws, actor: actorOf(ctx), action: "discord.payment_message", entityType: "workspace", entityId: ws, after: { message_id: messageId } });
  return json({ ok: true, message_id: messageId });
}

// ── Router ───────────────────────────────────────────────────────────────────

export function buildAdminRouter(): Router<Env> {
  return new Router<Env>()
    .get("/admin/workspace", getWorkspace)
    .patch("/admin/workspace", updateWorkspace)
    .get("/admin/reconcile", reconcile)
    .post("/admin/billing/initiate", billingInitiate)
    .post("/admin/members/import", membersImport)
    .get("/admin/notifications", notificationsStatus)
    .post("/admin/notifications/resend", notificationsResend)
    .post("/admin/notifications/reset", notificationsReset)
    .get("/admin/users", listUsers)
    .post("/admin/users", createUser)
    .patch("/admin/users/:id", updateUser)
    .get("/admin/plans", listPlans)
    .post("/admin/plans", createPlan)
    .patch("/admin/plans/:id", updatePlan)
    .get("/admin/subscriptions", listSubscriptions)
    .post("/admin/subscriptions", createSubscription)
    .patch("/admin/subscriptions/:id", updateSubscription)
    .get("/admin/channel-tags", listChannelTags)
    .post("/admin/channel-tags", createChannelTag)
    .patch("/admin/channel-tags/:id", updateChannelTag)
    .get("/admin/payments", listPayments)
    .post("/admin/payments/manual", manualPayment)
    .post("/admin/payments/:id/verify", verifyPaymentHandler)
    .post("/admin/payments/:id/reject", rejectPaymentHandler)
    .post("/admin/payments/:id/amount", overrideAmountHandler)
    .post("/admin/payments/:id/delete-proof", deleteProof)
    .post("/admin/upload-link", createUploadLink)
    .post("/admin/discord/payment-message", discordPaymentMessage);
}
