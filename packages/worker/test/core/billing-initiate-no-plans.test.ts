import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { initiateBillingOpened, previewBillingInitiate } from "../../src/core/billing";
import type { Notifier } from "../../src/core/notify";

/**
 * 沒有任何「會出現在公告裡」的方案時，發起繳費不能把此期標記成已開繳。
 * 公告名單只收「啟用中的方案」，所以訂閱掛在停用方案上的 workspace 會落在這個洞裡：
 * 舊實作先搶下 billing_opened 名額、才發現沒東西可公告，結果此期永遠是「已開繳但從沒通知過」，
 * 只能靠收回此期開繳救回來。預覽早就把這個情況叫做 no_plans，apply 必須說同一句話。
 */
const TS = "2026-05-01T00:00:00.000Z";
const WS = 9870, PLAN_OFF = 9870, USER = 9870, SUB = 9870;
const WS_EMPTY = 98701; // 有啟用方案，但沒有任何 active 訂閱
const CHAN = "chan-9870";
const PERIOD = "2029-01";

let sends = 0;
const notifier: Notifier = {
  async sendBillingOpened() { sends++; return true; },
  async sendOverdue() { return true; },
  async sendPaymentNudge() { return true; },
  async sendPaymentReceipt() { return true; },
};

const markerRows = async (ws: number, period: string) =>
  (await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM notification_logs WHERE workspace_id = ? AND type = 'billing_opened' AND period = ?"
  ).bind(ws, period).first<{ n: number }>())!.n;

beforeAll(async () => {
  (env as any).DISCORD_BOT_TOKEN = "test-bot-token";
  const settings = JSON.stringify({ discord_billing_channel_id: CHAN });
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO workspaces (id,name,owner_id,channel_type,billing_day,settings,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(WS, "W", "o", "discord", 1, settings, TS, TS),
    env.DB.prepare(`INSERT INTO workspaces (id,name,owner_id,channel_type,billing_day,settings,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(WS_EMPTY, "W2", "o", "discord", 1, settings, TS, TS),
    env.DB.prepare(`INSERT INTO users (id,workspace_id,display_name,created_at,updated_at) VALUES (?,?,?,?,?)`).bind(USER, WS, "U", TS, TS),
    // 停用的方案：訂閱還在、帳單照收，但公告不會列它
    env.DB.prepare(`INSERT INTO plans (id,workspace_id,name,provider,monthly_amount,active,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(PLAN_OFF, WS, "Retired", "openai", 200, 0, TS, TS),
    env.DB.prepare(`INSERT INTO plans (id,workspace_id,name,provider,monthly_amount,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`).bind(98702, WS_EMPTY, "ChatGPT", "openai", 315, TS, TS),
    env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(SUB, WS, USER, PLAN_OFF, "2029-01-01", 1, TS, TS),
  ]);
});

describe("發起繳費：沒有可公告的方案時", () => {
  it("預覽說 no_plans，apply 就不能搶下開繳名額", async () => {
    const preview = await previewBillingInitiate(env, WS, PERIOD, { amounts: [] });
    expect(preview).toMatchObject({ will_notify: false, notify_reason: "no_plans", opened: false });

    const before = sends;
    const r = await initiateBillingOpened(env, WS, PERIOD, { amounts: [] }, "owner@x", notifier);
    expect(r).toMatchObject({ sent: false, notifyReason: "no_plans" });
    expect(sends).toBe(before);
    // 這是這個修正的重點：沒有公告 = 沒有開繳紀錄，此期仍然是「未開繳」，可以修好方案後重來一次。
    expect(await markerRows(WS, PERIOD)).toBe(0);
  });

  it("帳單照樣建立 —— 預覽答應的 create 筆數必須等於 apply 的結果", async () => {
    // 預覽的 create 是照 active 訂閱算的（不管方案有沒有啟用），apply 也是；
    // 兩邊一致才是這裡的不變量，否則預覽就不能信。
    const preview = await previewBillingInitiate(env, WS, "2029-02", { amounts: [] });
    const r = await initiateBillingOpened(env, WS, "2029-02", { amounts: [] }, "owner@x", notifier);
    expect(r.createdPayments).toBe(preview.create.length);
    expect(r.createdPayments).toBe(1);
    expect(await markerRows(WS, "2029-02")).toBe(0);
  });

  it("完全沒有 active 訂閱的 workspace 也一樣不會被標成已開繳", async () => {
    const preview = await previewBillingInitiate(env, WS_EMPTY, PERIOD, { amounts: [] });
    expect(preview.notify_reason).toBe("no_plans");
    const r = await initiateBillingOpened(env, WS_EMPTY, PERIOD, { amounts: [] }, "owner@x", notifier);
    expect(r).toMatchObject({ sent: false, notifyReason: "no_plans", createdPayments: 0 });
    expect(await markerRows(WS_EMPTY, PERIOD)).toBe(0);
  });

  it("方案啟用之後，同一期別就能正常開繳並發出通知", async () => {
    await env.DB.prepare("UPDATE plans SET active = 1 WHERE id = ?").bind(PLAN_OFF).run();
    const before = sends;
    const r = await initiateBillingOpened(env, WS, PERIOD, { amounts: [] }, "owner@x", notifier);
    expect(r).toMatchObject({ sent: true, notifyReason: "ok" });
    expect(sends).toBe(before + 1);
    expect(await markerRows(WS, PERIOD)).toBe(1);
  });
});
