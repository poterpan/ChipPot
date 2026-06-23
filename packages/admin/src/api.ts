const BASE = "/api/admin";

async function req<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { "content-type": "application/json" };
  }
  const r = await fetch(BASE + path, init);
  if (r.status === 401 || r.status === 403) throw new Error("未授權，請重新登入後再試。");
  const data = (await r.json().catch(() => ({}))) as any;
  if (!r.ok) throw new Error(data?.error ?? `錯誤 ${r.status}`);
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
  id: number; period: string; amount: number; status: string; has_proof: number;
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

export const api = {
  workspace: () => req<{ workspace: any; r2_configured: boolean }>("GET", "/workspace"),
  updateWorkspace: (b: unknown) => req("PATCH", "/workspace", b),
  rebuildPaymentMessage: () => req<{ message_id: string }>("POST", "/discord/payment-message"),
  rebuildBindMessage: () => req<{ message_id: string }>("POST", "/discord/bind-message"),
  registerCommands: () => req<{ ok: boolean; registered: number }>("POST", "/discord/register-commands"),
  reconcile: (period: string) => req<Reconcile>("GET", `/reconcile${qs({ period })}`),
  notifications: (period: string) => req<{ billing_opened: { sent_at: string } | null; overdue: { sent_at: string } | null }>("GET", `/notifications${qs({ period })}`),
  resendNotification: (type: string, period: string) => req<{ sent?: boolean; count?: number }>("POST", "/notifications/resend", { type, period }),
  resetNotification: (type: string, period: string) => req<{ deleted: number }>("POST", "/notifications/reset", { type, period }),
  testNotification: (b: { kind: "bark" | "webhook"; bark_key?: string; bark_server?: string; webhook_url?: string; template?: string }) =>
    req<{ ok: boolean; status?: number; error?: string }>("POST", "/notifications/test", b),
  initiateBilling: (b: { period: string; amounts: { plan_id: number; amount: number }[] }) =>
    req<{ sent: boolean; updated_plans: number; updated_payments: number }>("POST", "/billing/initiate", b),
  payments: (p?: { period?: string; status?: string }) => req<{ payments: Payment[] }>("GET", `/payments${qs(p)}`),
  verify: (id: number, tagId: number | null) => req("POST", `/payments/${id}/verify`, { verified_channel_tag_id: tagId }),
  reject: (id: number, reason: string) => req("POST", `/payments/${id}/reject`, { rejected_reason: reason }),
  overrideAmount: (id: number, amount: number) => req("POST", `/payments/${id}/amount`, { amount }),
  deleteProof: (id: number) => req("POST", `/payments/${id}/delete-proof`),
  deletePayment: (id: number) => req<{ ok: boolean }>("DELETE", `/payments/${id}`),
  unverify: (id: number) => req<{ ok: boolean }>("POST", `/payments/${id}/unverify`),
  syncPeriodBills: (period: string, opts: { dry_run: boolean; notify_added?: boolean }) =>
    req<ReconcileDiff | ReconcileApplied>("POST", `/billing/${period}/sync`, opts),
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
  importMembers: async (file: File, startDate?: string) => {
    const fd = new FormData();
    fd.append("file", file);
    if (startDate) fd.append("start_date", startDate);
    const r = await fetch(`${BASE}/members/import`, { method: "POST", body: fd });
    const data = (await r.json().catch(() => ({}))) as any;
    if (!r.ok) throw new Error(data?.error ?? `錯誤 ${r.status}`);
    return data as { summary: { usersCreated: number; usersUpdated: number; subsCreated: number; subsSkipped: number; rowsSkipped: number; unmatchedPlans: string[] } };
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
