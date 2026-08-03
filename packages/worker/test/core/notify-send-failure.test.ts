import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { initiateBillingOpened, resendBillingOpenedNotice } from "../../src/core/billing";
import { sendOverdueForPeriod } from "../../src/core/scheduled";
import { discordNotifier } from "../../src/adapters/discord/notify";
import { claimNotification, isBillingOpened } from "../../src/core/notify";

/**
 * Discord 回非 2xx 時，三條發送路徑（發起繳費／重發開繳通知／催繳）都不能謊報成功。
 * 這裡刻意用「真的」discordNotifier + 502 的 fetch stub，而不是假 notifier —— 要驗的正是
 * 「送失敗」這件事有沒有一路傳回呼叫端，假 notifier 會把待測的那一段短路掉。
 */
const TS = "2026-05-01T00:00:00.000Z";
const WS = 9860, PLAN = 9860, USER = 9860, SUB = 9860;
const CHAN = "chan-9860";
const P_INIT = "2028-01";     // 由發起繳費開繳
const P_RESEND = "2028-02";   // 已開繳，要重發
const P_OVERDUE = "2028-03";  // 有待繳帳單，要催繳

const fail502 = () => vi.fn(async () => new Response("bad gateway", { status: 502 }));
const ok200 = () => vi.fn(async () => new Response(JSON.stringify({ id: "m-9860" }), { status: 200 }));

async function lastAudit(action: string): Promise<Record<string, unknown>> {
  const r = await env.DB.prepare(
    "SELECT after_json FROM audit_logs WHERE workspace_id = ? AND action = ? ORDER BY id DESC LIMIT 1"
  ).bind(WS, action).first<{ after_json: string }>();
  return JSON.parse(r!.after_json);
}
const overdueSlots = async (period: string) =>
  (await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM notification_logs WHERE workspace_id = ? AND type = 'overdue' AND period = ?"
  ).bind(WS, period).first<{ n: number }>())!.n;

beforeAll(async () => {
  (env as any).DISCORD_BOT_TOKEN = "test-bot-token";
  const settings = JSON.stringify({ discord_billing_channel_id: CHAN, overdue_days: 3 });
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO workspaces (id,name,owner_id,channel_type,billing_day,settings,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(WS, "W", "o", "discord", 1, settings, TS, TS),
    env.DB.prepare(`INSERT INTO users (id,workspace_id,discord_id,display_name,created_at,updated_at) VALUES (?,?,?,?,?,?)`).bind(USER, WS, "d-9860", "U", TS, TS),
    env.DB.prepare(`INSERT INTO plans (id,workspace_id,name,provider,monthly_amount,discord_role_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(PLAN, WS, "ChatGPT", "openai", 315, "role-9860", TS, TS),
    env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(SUB, WS, USER, PLAN, "2028-01-01", 1, TS, TS),
    // 催繳要有名單可列
    env.DB.prepare(`INSERT INTO payments (workspace_id,subscription_id,period,period_start,period_end,due_date,amount,status,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).bind(WS, SUB, P_OVERDUE, `${P_OVERDUE}-01`, `${P_OVERDUE}-31`, `${P_OVERDUE}-05`, 315, "pending", "cron", TS, TS),
  ]);
});

describe("發起繳費：通知送不出去時", () => {
  it("回報 send_failed 而不是 sent，帳單／開繳狀態照實留著", async () => {
    vi.stubGlobal("fetch", fail502());
    const r = await initiateBillingOpened(env, WS, P_INIT, { amounts: [{ plan_id: PLAN, amount: 400 }] }, "owner@x", discordNotifier);
    vi.unstubAllGlobals();

    expect(r.sent).toBe(false);
    expect(r.notifyReason).toBe("send_failed");
    // 寫入的部分照樣發生，而且照實回報 —— 這通呼叫真的建了帳單、真的改了定價。
    expect(r.createdPayments).toBe(1);
    expect(r.updatedPlans).toBe(1);
    // marker 不回收：帳單已經在那裡了，回收會讓本期變成「有帳單卻不能繳」的半套狀態
    // （同 routes/admin.ts notificationsReset 的 409 所擋的情況）。補救路徑是「重發開繳通知」。
    expect(await isBillingOpened(env.DB, WS, P_INIT)).toBe(true);
    expect(await lastAudit("billing.initiate")).toMatchObject({ period: P_INIT, sent: false, notify_reason: "send_failed" });
  });

  it("同一期別再送一次仍是 already_sent（失敗不會把名額還回去）", async () => {
    vi.stubGlobal("fetch", ok200());
    const r = await initiateBillingOpened(env, WS, P_INIT, { amounts: [] }, "owner@x", discordNotifier);
    vi.unstubAllGlobals();
    expect(r).toMatchObject({ sent: false, notifyReason: "already_sent" });
  });
});

describe("重發開繳通知：通知送不出去時", () => {
  const STALE = "2020-01-01T00:00:00.000Z";
  const sentAt = async () =>
    (await env.DB.prepare(
      "SELECT sent_at FROM notification_logs WHERE workspace_id = ? AND type = 'billing_opened' AND period = ?"
    ).bind(WS, P_RESEND).first<{ sent_at: string }>())!.sent_at;

  beforeAll(async () => {
    await claimNotification(env.DB, { workspaceId: WS, type: "billing_opened", period: P_RESEND });
    await env.DB.prepare(
      "UPDATE notification_logs SET sent_at = ? WHERE workspace_id = ? AND type = 'billing_opened' AND period = ?"
    ).bind(STALE, WS, P_RESEND).run();
  });

  it("回報 send_failed，且不把 sent_at 更新成現在", async () => {
    vi.stubGlobal("fetch", fail502());
    const r = await resendBillingOpenedNotice(env, WS, P_RESEND, discordNotifier, { dryRun: false });
    vi.unstubAllGlobals();
    expect(r).toMatchObject({ outcome: "send_failed", sent: false });
    // sent_at 是「上次真的送出去的時間」；沒送成功就不能往前推。
    expect(await sentAt()).toBe(STALE);
  });

  it("下一次送成功才更新 sent_at", async () => {
    vi.stubGlobal("fetch", ok200());
    const r = await resendBillingOpenedNotice(env, WS, P_RESEND, discordNotifier, { dryRun: false });
    vi.unstubAllGlobals();
    expect(r).toMatchObject({ outcome: "sent", sent: true });
    expect(await sentAt() > STALE).toBe(true);
  });
});

describe("催繳：通知送不出去時", () => {
  it("回報 send_failed、notified 0，並把已佔用的催繳名額還回去", async () => {
    vi.stubGlobal("fetch", fail502());
    const r = await sendOverdueForPeriod(env, WS, P_OVERDUE, discordNotifier, { force: true });
    vi.unstubAllGlobals();
    expect(r.outcome).toBe("send_failed");
    expect(r.notified).toBe(0);
    // 名額若留著，這期就永遠不會再被催繳（claimNotification 之後只會回 already_sent，
    // 而且沒有任何地方會報錯）—— 跟收回本期開繳釋放 overdue slot 是同一個理由。
    expect(await overdueSlots(P_OVERDUE)).toBe(0);
  });

  it("名額還回去之後，每日自動催繳仍會再送一次", async () => {
    vi.stubGlobal("fetch", ok200());
    const r = await sendOverdueForPeriod(env, WS, P_OVERDUE, discordNotifier, {
      force: false, now: new Date("2028-04-20T00:00:00Z"),
    });
    vi.unstubAllGlobals();
    expect(r).toMatchObject({ outcome: "sent", notified: 1 });
    expect(await overdueSlots(P_OVERDUE)).toBe(1);
  });
});
