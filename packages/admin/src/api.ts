const BASE = "/api/admin";

/**
 * What every failed call throws. `status` is what lets a caller tell an EXPECTED refusal apart from
 * a real failure: 重發開繳通知 has to render 「此期尚未開繳」 as a state of its screen, and the worker
 * reports that as a 409 rather than as an outcome in the body (routes/admin.ts notificationsResend).
 * Callers that only read `.message` are unaffected.
 */
export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ApiError";
  }
}

async function req<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { "content-type": "application/json" };
  }
  const r = await fetch(BASE + path, init);
  if (r.status === 401 || r.status === 403) throw new ApiError("未授權，請重新登入後再試。", r.status);
  const data = (await r.json().catch(() => ({}))) as any;
  if (!r.ok) throw new ApiError(data?.error ?? `錯誤 ${r.status}`, r.status);
  return data as T;
}

function qs(params?: Record<string, string | number | undefined>): string {
  if (!params) return "";
  const parts = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`);
  return parts.length ? `?${parts.join("&")}` : "";
}

export interface Payment {
  id: number; user_id: number; period: string; amount: number; status: string; has_proof: number;
  screenshot_key: string | null; proof_deleted_at: string | null; payment_note: string | null;
  verified_channel_tag_id: number | null; channel_tag_name: string | null;
  declared_channel_tag_id: number | null; declared_channel_tag_name: string | null; source: string;
  rejected_reason: string | null; user_name: string; plan_name: string;
  paid_at: string | null; submitted_at: string | null; verified_by: string | null; due_date: string;
}
export interface Reconcile {
  period: string;
  status_counts: { pending: number; paid: number; verified: number; rejected: number };
  total_amount_due: number; verified_amount: number; no_proof_count: number;
  by_plan: { plan_id: number; plan_name: string; total: number; pending: number; paid: number; verified: number; rejected: number; amount_due: number; amount_verified: number }[];
  by_channel_tag: { channel_tag_id: number | null; channel_tag_name: string | null; count: number; amount: number }[];
}
export interface ChannelTag { id: number; name: string; type: string | null; active: number; sort_order: number; usage_count?: number }
export interface Plan { id: number; name: string; provider: string; monthly_amount: number; discord_role_id: string | null; active: number; subscription_count?: number }
export interface User { id: number; display_name: string; discord_id: string | null; email: string | null; note: string | null; subscription_count?: number; payment_count?: number }
export interface Subscription { id: number; user_name: string; plan_name: string; status: string; start_date: string; billing_day: number; custom_cycle: number; user_id: number; plan_id: number; payment_count?: number }
export interface ReconcileLine { payment_id?: number; subscription_id: number; user_id: number; user_name: string; plan_name: string; amount: number; from?: number; to?: number; discord_id: string | null }
export interface ReconcileDiff { opened: boolean; add: ReconcileLine[]; remove: ReconcileLine[]; reprice: ReconcileLine[]; frozen_count: number }
export interface ReconcileApplied { ok: boolean; applied: { added: number; removed: number; repriced: number; frozen: number }; notified: number }
/** 收回本期開繳 — preview and apply share `opened`/counts; `removed` only comes back on the preview. */
export interface RetractPreview { opened: boolean; removed: ReconcileLine[]; frozen_count: number }
export interface RetractApplied { ok: boolean; opened: boolean; applied: { removed: number; frozen: number } }
/**
 * POST /admin/notifications/resend, type = billing_opened.
 * `not_opened` never arrives in a 200 body — the route turns it into a 409, so the caller sees a
 * thrown Error instead. It stays in the union to mirror the worker's ResendOutcome.
 */
export interface ResendBillingPreview {
  ok: true; dry_run: boolean;
  outcome: "sent" | "preview" | "not_opened" | "no_channel" | "no_bot_token" | "no_plans";
  sent: boolean;
  lines: { plan_id: number; plan_name: string; amount: number; role_id: string | null }[];
}
/**
 * POST /admin/notifications/resend, type = overdue.
 * `overdue_days` is only meaningful once the workspace settings were read: the no-channel outcomes
 * can carry 0, so never render it outside the sent/preview outcomes.
 */
export interface OverduePreview {
  ok: true; dry_run: boolean;
  outcome: "sent" | "preview" | "no_channel" | "no_bot_token" | "none_due" | "already_sent";
  count: number; overdue_days: number;
  people: { user_id: number; user_name: string; discord_id: string | null; total: number }[];
}
/** POST /admin/billing/initiate with dry_run (the default). */
export interface InitiatePreview {
  period: string; opened: boolean; will_notify: boolean;
  notify_reason: "ok" | "already_sent" | "no_channel" | "no_bot_token" | "no_plans";
  plan_changes: { plan_id: number; plan_name: string; from: number; to: number }[];
  create: ReconcileLine[]; reprice: ReconcileLine[]; frozen_count: number;
}
export interface InitiateApplied {
  ok: true; sent: boolean; updated_plans: number; created_payments: number; updated_payments: number;
}

/**
 * Why a notice will not / did not go out. Every outward-facing action reports the real outcome
 * instead of a blanket "✓ 完成" (issue #43 / A1) — these are the sentences it reports.
 *
 * Only the outcomes that mean "nothing was sent" are listed: `ok` / `sent` / `preview` have no
 * failure sentence, so a lookup on those is undefined. Index with a `??` fallback — the map is a
 * plain Record and TypeScript will not flag the missing key.
 */
export const NOTIFY_REASON_TEXT: Record<string, string> = {
  no_channel: "尚未設定繳費頻道 ID（設定 → Discord 串接）",
  no_bot_token: "尚未設定 Discord bot token",
  no_plans: "本期沒有任何有啟用訂閱的方案",
  already_sent: "本期開繳通知先前已發送，不會重複發送",
  not_opened: "此期尚未開繳",
  none_due: "本期沒有未繳的成員",
};
export interface ImportUserLine { user_id: number | null; user_name: string; email: string }
export interface ImportSubLine {
  subscription_id: number | null; user_id: number | null; user_name: string; email: string;
  plan_id: number; plan_name: string; amount: number;
}
export interface ImportBillLine {
  payment_id: number; subscription_id: number; user_name: string; plan_name: string;
  period: string; amount: number; status: string;
}
/** Mirrors ImportDiff in worker/src/core/import.ts — the same shape for a preview and an apply. */
export interface ImportDiff {
  dry_run: boolean; period: string;
  users_created: ImportUserLine[]; users_updated: number;
  subs_added: ImportSubLine[]; subs_reactivated: ImportSubLine[]; subs_paused: ImportSubLine[];
  cancelled_conflicts: ImportSubLine[];
  subs_skipped: number; rows_skipped: number; unmatched_plans: string[];
  affected_pending_bills: ImportBillLine[];
}

export const api = {
  workspace: () => req<{ workspace: any; r2_configured: boolean }>("GET", "/workspace"),
  updateWorkspace: (b: unknown) => req("PATCH", "/workspace", b),
  rebuildPaymentMessage: () => req<{ message_id: string }>("POST", "/discord/payment-message"),
  rebuildBindMessage: () => req<{ message_id: string }>("POST", "/discord/bind-message"),
  registerCommands: () => req<{ ok: boolean; registered: number }>("POST", "/discord/register-commands"),
  reconcile: (period: string) => req<Reconcile>("GET", `/reconcile${qs({ period })}`),
  notifications: (period: string) => req<{ billing_opened: { sent_at: string } | null; overdue: { sent_at: string } | null }>("GET", `/notifications${qs({ period })}`),
  resendNotification: (type: string, period: string, opts: { dry_run: boolean }) =>
    req<ResendBillingPreview | OverduePreview>("POST", "/notifications/resend", { type, period, ...opts }),
  resetNotification: (type: string, period: string) => req<{ deleted: number }>("POST", "/notifications/reset", { type, period }),
  testNotification: (b: { kind: "bark" | "webhook"; bark_key?: string; bark_server?: string; webhook_url?: string; template?: string }) =>
    req<{ ok: boolean; status?: number; error?: string }>("POST", "/notifications/test", b),
  initiateBilling: (b: { period: string; amounts: { plan_id: number; amount: number }[]; dry_run: boolean }) =>
    req<InitiatePreview | InitiateApplied>("POST", "/billing/initiate", b),
  payments: (p?: { period?: string; status?: string; user_id?: number; id?: number }) =>
    req<{ payments: Payment[] }>("GET", `/payments${qs(p)}`),
  verify: (id: number, tagId: number | null) => req("POST", `/payments/${id}/verify`, { verified_channel_tag_id: tagId }),
  verifyAll: (userId: number, period: string) =>
    req<{ ok: boolean; verified: number; payment_ids: number[] }>("POST", "/payments/verify-all", { user_id: userId, period }),
  reject: (id: number, reason: string) => req("POST", `/payments/${id}/reject`, { rejected_reason: reason }),
  overrideAmount: (id: number, amount: number) => req("POST", `/payments/${id}/amount`, { amount }),
  deleteProof: (id: number) => req("POST", `/payments/${id}/delete-proof`),
  deletePayment: (id: number) => req<{ ok: boolean }>("DELETE", `/payments/${id}`),
  unverify: (id: number) => req<{ ok: boolean }>("POST", `/payments/${id}/unverify`),
  syncPeriodBills: (period: string, opts: { dry_run: boolean; notify_added?: boolean }) =>
    req<ReconcileDiff | ReconcileApplied>("POST", `/billing/${period}/sync`, opts),
  retractPeriodBilling: (period: string, opts: { dry_run: boolean }) =>
    req<RetractPreview | RetractApplied>("POST", `/billing/${period}/retract`, opts),
  manualPayment: (b: unknown) => req("POST", "/payments/manual", b),
  uploadLink: (b: unknown) => req<{ token: string; path: string; url: string; expires_at: string }>("POST", "/upload-link", b),
  users: () => req<{ users: User[] }>("GET", "/users"),
  createUser: (b: unknown) => req("POST", "/users", b),
  updateUser: (id: number, b: unknown) => req("PATCH", `/users/${id}`, b),
  deleteUser: (id: number) => req<{ ok: boolean; deleted: { subscriptions: number; payments: number } }>("DELETE", `/users/${id}`),
  subscriptions: () => req<{ subscriptions: Subscription[] }>("GET", "/subscriptions"),
  createSubscription: (b: unknown) => req("POST", "/subscriptions", b),
  updateSubscription: (id: number, b: unknown) => req("PATCH", `/subscriptions/${id}`, b),
  deleteSubscription: (id: number) => req<{ ok: boolean; deleted: { payments: number } }>("DELETE", `/subscriptions/${id}`),
  plans: () => req<{ plans: Plan[] }>("GET", "/plans"),
  createPlan: (b: unknown) => req("POST", "/plans", b),
  updatePlan: (id: number, b: unknown) => req("PATCH", `/plans/${id}`, b),
  deletePlan: (id: number) => req("DELETE", `/plans/${id}`),
  channelTags: () => req<{ channel_tags: ChannelTag[] }>("GET", "/channel-tags"),
  createChannelTag: (b: unknown) => req("POST", "/channel-tags", b),
  updateChannelTag: (id: number, b: unknown) => req("PATCH", `/channel-tags/${id}`, b),
  deleteChannelTag: (id: number) => req("DELETE", `/channel-tags/${id}`),
  imageUrl: (key: string) => `${BASE}/image?key=${encodeURIComponent(key)}`,
  importMembers: async (file: File, opts: { startDate?: string; dryRun: boolean }) => {
    const fd = new FormData();
    fd.append("file", file);
    if (opts.startDate) fd.append("start_date", opts.startDate);
    // The endpoint previews unless it sees exactly "false", so always send the flag explicitly.
    fd.append("dry_run", opts.dryRun ? "true" : "false");
    const r = await fetch(`${BASE}/members/import`, { method: "POST", body: fd });
    const data = (await r.json().catch(() => ({}))) as any;
    if (!r.ok) throw new Error(data?.error ?? `錯誤 ${r.status}`);
    return data as { ok: boolean; diff: ImportDiff };
  },
};

function taipeiYMD(now: Date): { y: number; m: number; d: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  return { y: get("year"), m: get("month"), d: get("day") };
}

/** Current calendar month (YYYY-MM) in Asia/Taipei. */
export function currentPeriod(): string {
  const { y, m } = taipeiYMD(new Date());
  return `${y}-${String(m).padStart(2, "0")}`;
}

/**
 * The billing period the dashboard should default to, given the workspace billing day.
 * A period's bills open on its billing day, so before that day we're still collecting the
 * previous month — default to it; on/after the billing day, default to the current month.
 * (With billing_day = 1 this is always the current calendar month.)
 */
export function periodForBillingDay(billingDay: number, now: Date = new Date()): string {
  const { y, m, d } = taipeiYMD(now);
  if (d >= billingDay) return `${y}-${String(m).padStart(2, "0")}`;
  const pm = m === 1 ? 12 : m - 1;
  const py = m === 1 ? y - 1 : y;
  return `${py}-${String(pm).padStart(2, "0")}`;
}

/**
 * The period "發起繳費" should default to: on/before the billing day → the current month, after
 * it → next month. Lets the admin pre-open next month near month-end (forward-looking; this is
 * the mirror of periodForBillingDay, which looks back at the period still being collected).
 */
export function nextBillingPeriod(billingDay: number, now: Date = new Date()): string {
  const { y, m, d } = taipeiYMD(now);
  if (d <= billingDay) return `${y}-${String(m).padStart(2, "0")}`;
  const nm = m === 12 ? 1 : m + 1;
  const ny = m === 12 ? y + 1 : y;
  return `${ny}-${String(nm).padStart(2, "0")}`;
}
