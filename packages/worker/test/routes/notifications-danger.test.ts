import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { buildAdminRouter } from "../../src/routes/admin";
import { claimNotification } from "../../src/core/notify";

const router = buildAdminRouter();
const IDENT = { email: "owner@example.com" };
function call(method: string, path: string, body?: unknown) {
  const init: RequestInit = { method };
  if (body !== undefined) { init.body = JSON.stringify(body); init.headers = { "content-type": "application/json" }; }
  return router.handle(new Request(`https://x${path}`, init), env, { identity: IDENT });
}

// 這些 route 都作用在 DEFAULT_WORKSPACE_ID = 1（seed 的 workspace）。本檔只碰它的
// notification_logs 與 2097-xx 期別，不建立自己的 workspace fixture（band 9820）。
const OPENED = "2097-01";
const UNOPENED = "2097-02";

/** 目前為止寫下的 notification.resend 稽核筆數 —— 預覽不該讓它變多。 */
async function resendAuditCount(): Promise<number> {
  const r = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'notification.resend' AND actor = ?"
  ).bind(IDENT.email).first<{ n: number }>();
  return r!.n;
}
async function lastResendAudit(): Promise<{ type: string; period: string; outcome: string; count?: number }> {
  const r = await env.DB.prepare(
    "SELECT after_json FROM audit_logs WHERE action = 'notification.resend' AND actor = ? ORDER BY id DESC LIMIT 1"
  ).bind(IDENT.email).first<{ after_json: string }>();
  return JSON.parse(r!.after_json);
}
const paymentCount = async (period: string) =>
  (await env.DB.prepare("SELECT COUNT(*) AS n FROM payments WHERE workspace_id = 1 AND period = ?")
    .bind(period).first<{ n: number }>())!.n;

beforeAll(async () => {
  (env as any).DISCORD_BOT_TOKEN = "test-bot-token";
  await call("PATCH", "/admin/workspace", { settings: { discord_billing_channel_id: "chan-9820" } });
  // 一位在 OPENED 期別有待繳帳單的成員 —— 催繳的名單才有東西可列。
  const u = await call("POST", "/admin/users", { display_name: "催繳-9820", discord_id: "d-9820" });
  const uid = ((await u!.json()) as any).id as number;
  await call("POST", "/admin/subscriptions", { user_id: uid, plan_id: 1, start_date: `${OPENED}-01` });
  await claimNotification(env.DB, { workspaceId: 1, type: "billing_opened", period: OPENED });
});

describe("POST /admin/notifications/resend", () => {
  it("未開繳的期別回 409 並指向發起繳費，不會偷偷開繳", async () => {
    const audits = await resendAuditCount();
    const r = await call("POST", "/admin/notifications/resend", { type: "billing_opened", period: UNOPENED, dry_run: false });
    expect(r!.status).toBe(409);
    expect(((await r!.json()) as any).error).toContain("發起繳費");
    // 舊實作會在這裡建帳單並廣播；409 保護的正是這個。
    expect(await paymentCount(UNOPENED)).toBe(0);
    expect(await resendAuditCount()).toBe(audits);
    // modal 一開啟就是 dry run，「無法重發」那一頁靠的就是這個 409。
    const preview = await call("POST", "/admin/notifications/resend", { type: "billing_opened", period: UNOPENED });
    expect(preview!.status).toBe(409);
  });

  it("預設是 dry run：回傳公告名單但不發送", async () => {
    const audits = await resendAuditCount();
    const fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    const r = await call("POST", "/admin/notifications/resend", { type: "billing_opened", period: OPENED });
    vi.unstubAllGlobals();
    expect(r!.status).toBe(200);
    const b = (await r!.json()) as any;
    expect(b.dry_run).toBe(true);
    expect(b.sent).toBe(false);
    expect(b.outcome).toBe("preview");
    expect(Array.isArray(b.lines)).toBe(true);
    expect(b.lines.length).toBeGreaterThanOrEqual(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await resendAuditCount()).toBe(audits); // 預覽不留稽核
  });

  it("overdue 的 dry run 回傳名單與 overdue_days，且不發送、不留稽核", async () => {
    const audits = await resendAuditCount();
    const fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    const r = await call("POST", "/admin/notifications/resend", { type: "overdue", period: OPENED });
    vi.unstubAllGlobals();
    expect(r!.status).toBe(200);
    const b = (await r!.json()) as any;
    expect(b.dry_run).toBe(true);
    expect(b.outcome).toBe("preview");
    expect(b.count).toBe(0); // dry run 沒有真的通知任何人
    expect(typeof b.overdue_days).toBe("number");
    expect(Array.isArray(b.people)).toBe(true);
    expect(b.people.map((p: any) => p.user_name)).toContain("催繳-9820");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await resendAuditCount()).toBe(audits);
  });

  it("overdue 的 apply 真的發送，並把 outcome 記進稽核", async () => {
    const fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    const r = await call("POST", "/admin/notifications/resend", { type: "overdue", period: OPENED, dry_run: false });
    vi.unstubAllGlobals();
    expect(r!.status).toBe(200);
    const b = (await r!.json()) as any;
    expect(b.dry_run).toBe(false);
    expect(b.outcome).toBe("sent");
    expect(b.count).toBeGreaterThanOrEqual(1);
    expect(fetchSpy).toHaveBeenCalled();
    expect(await lastResendAudit()).toMatchObject({ type: "overdue", period: OPENED, outcome: "sent", count: b.count });
  });
});

describe("POST /admin/notifications/reset", () => {
  it("拒絕重置 billing_opened，並指向收回此期開繳", async () => {
    const r = await call("POST", "/admin/notifications/reset", { type: "billing_opened", period: OPENED });
    expect(r!.status).toBe(409);
    expect(((await r!.json()) as any).error).toContain("收回此期開繳");
    // marker 必須還在 —— 這正是這個 409 要保護的東西
    const row = await env.DB.prepare(
      "SELECT 1 AS ok FROM notification_logs WHERE workspace_id = 1 AND type = 'billing_opened' AND period = ?"
    ).bind(OPENED).first<{ ok: number }>();
    expect(row).toBeTruthy();
  });

  it("overdue 的重置照常運作", async () => {
    await claimNotification(env.DB, { workspaceId: 1, type: "overdue", period: OPENED });
    const r = await call("POST", "/admin/notifications/reset", { type: "overdue", period: OPENED });
    expect(r!.status).toBe(200);
    expect(((await r!.json()) as any).deleted).toBeGreaterThanOrEqual(1);
  });
});
