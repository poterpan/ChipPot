import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { announcePaymentReceipt } from "../../src/core/receipt";
import { claimNotification, type Notifier, type ReceiptTarget } from "../../src/core/notify";
import { settleUserPeriod } from "../../src/core/storage";

// Fresh id band for this file: workspace/plan 9810, user 98101, subs 98110-98111, payments 98120-98121.
const TS = "2026-05-01T00:00:00.000Z";
const WS = 9810;
const CHAN = "chan-9810";
const USER = 98101;
const SUB_A = 98110, SUB_B = 98111;
const PAY_A = 98120, PAY_B = 98121;
const P = "2029-04";

const sent: { kind: string; target: ReceiptTarget; reason: string | null }[] = [];
const base: Notifier = {
  async sendBillingOpened() { return true; },
  async sendOverdue() { return true; },
  async sendPaymentNudge() { return true; },
  async sendPaymentReceipt(_e, _ch, _ws, kind, target, reason) { sent.push({ kind, target, reason }); return true; },
};
// The Notifier contract says a refused send is `false`, not a throw (core/notify.ts).
const failing: Notifier = { ...base, async sendPaymentReceipt() { return false; } };

beforeAll(async () => {
  (env as any).DISCORD_BOT_TOKEN = "test-bot-token";
  // verify receipts are opt-in (Task 4); this fixture turns them on so both kinds are exercised.
  const settings = JSON.stringify({ discord_billing_channel_id: CHAN, receipt_notify_verified: true });
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO workspaces (id,name,owner_id,channel_type,billing_day,settings,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(WS, "W", "o", "discord", 5, settings, TS, TS),
    env.DB.prepare(`INSERT INTO users (id,workspace_id,discord_id,display_name,created_at,updated_at) VALUES (?,?,?,?,?,?)`).bind(USER, WS, "d-9810", "王小明", TS, TS),
    env.DB.prepare(`INSERT INTO plans (id,workspace_id,name,provider,monthly_amount,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`).bind(WS, WS, "ChatGPT", "openai", 315, TS, TS),
    env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`).bind(SUB_A, WS, USER, WS, "2029-04-01", 5, "active", TS, TS),
    env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`).bind(SUB_B, WS, USER, WS, "2029-04-01", 5, "active", TS, TS),
    env.DB.prepare(`INSERT INTO payments (id,workspace_id,subscription_id,period,period_start,period_end,due_date,amount,status,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).bind(PAY_A, WS, SUB_A, P, `${P}-01`, `${P}-30`, `${P}-05`, 315, "pending", "cron", TS, TS),
    env.DB.prepare(`INSERT INTO payments (id,workspace_id,subscription_id,period,period_start,period_end,due_date,amount,status,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).bind(PAY_B, WS, SUB_B, P, `${P}-01`, `${P}-30`, `${P}-05`, 251, "pending", "cron", TS, TS),
    env.DB.prepare(`INSERT INTO notification_logs (workspace_id,type,period,plan_id,user_id,subscription_id,event,sent_at) VALUES (?,?,?,?,?,?,?,?)`).bind(WS, "billing_opened", P, 0, 0, 0, "", TS),
  ]);
});

describe("announcePaymentReceipt", () => {
  it("announces a rejection once and claims that bill's reject slot", async () => {
    sent.length = 0;
    expect(await announcePaymentReceipt(env, { workspaceId: WS, kind: "reject", paymentIds: [PAY_A], reason: "金額不符" }, base)).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.target.lines).toEqual([{ plan_name: "ChatGPT", amount: 315 }]);
    expect(sent[0]!.reason).toBe("金額不符");
    // the slot is genuinely taken now
    expect(await claimNotification(env.DB, { workspaceId: WS, type: "receipt", period: P, userId: USER, subscriptionId: SUB_A, event: "reject" })).toBe(false);
  });

  it("does not announce the same rejection twice", async () => {
    sent.length = 0;
    expect(await announcePaymentReceipt(env, { workspaceId: WS, kind: "reject", paymentIds: [PAY_A], reason: "金額不符" }, base)).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it("announces the verify of the same bill (a different event, a different slot)", async () => {
    sent.length = 0;
    expect(await announcePaymentReceipt(env, { workspaceId: WS, kind: "verify", paymentIds: [PAY_A], reason: null }, base)).toBe(1);
    expect(sent[0]!.kind).toBe("verify");
  });

  it("aggregates several bills of one member into ONE message", async () => {
    sent.length = 0;
    expect(await announcePaymentReceipt(env, { workspaceId: WS, kind: "verify", paymentIds: [PAY_A, PAY_B], reason: null }, base)).toBe(1);
    // PAY_A's verify slot was taken by the previous test, so only PAY_B is left to announce.
    expect(sent).toHaveLength(1);
    expect(sent[0]!.target.lines).toHaveLength(1);
    expect(sent[0]!.target.total).toBe(251);
  });

  it("re-announces a rejection after the member re-submits", async () => {
    // The member settles the period: the bills go back to paid, releasing the receipt slots.
    await settleUserPeriod(env, { workspaceId: WS, userId: USER, period: P, source: "user_slash", paymentNote: "重送" });
    sent.length = 0;
    expect(await announcePaymentReceipt(env, { workspaceId: WS, kind: "reject", paymentIds: [PAY_A], reason: "還是不對" }, base)).toBe(1);
    expect(sent[0]!.reason).toBe("還是不對");
  });

  it("gives the slot back when the send fails, so a later attempt still announces", async () => {
    const other = { workspaceId: WS, kind: "verify" as const, paymentIds: [PAY_B], reason: null };
    sent.length = 0;
    expect(await announcePaymentReceipt(env, other, failing)).toBe(0);
    expect(await announcePaymentReceipt(env, other, base)).toBe(1);
  });

  it("does not burn a slot when there is nowhere to send", async () => {
    const noChannel = 9819;
    await env.DB.prepare(`INSERT INTO workspaces (id,name,owner_id,channel_type,billing_day,settings,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`)
      .bind(noChannel, "W2", "o", "discord", 5, "{}", TS, TS).run();
    expect(await announcePaymentReceipt(env, { workspaceId: noChannel, kind: "reject", paymentIds: [PAY_A] }, base)).toBe(0);
    const rows = await env.DB.prepare("SELECT COUNT(*) c FROM notification_logs WHERE workspace_id = ?").bind(noChannel).first<{ c: number }>();
    expect(rows!.c).toBe(0);
  });
});

describe("verify receipts are opt-in", () => {
  const WS_OFF = 9818;
  const CHAN_OFF = "chan-9818";
  const U_OFF = 98181, S_OFF = 98182, P_OFF = 98183;

  beforeAll(async () => {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO workspaces (id,name,owner_id,channel_type,billing_day,settings,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(WS_OFF, "W", "o", "discord", 5, JSON.stringify({ discord_billing_channel_id: CHAN_OFF }), TS, TS),
      env.DB.prepare(`INSERT INTO users (id,workspace_id,discord_id,display_name,created_at,updated_at) VALUES (?,?,?,?,?,?)`).bind(U_OFF, WS_OFF, "d-9818", "李小華", TS, TS),
      env.DB.prepare(`INSERT INTO plans (id,workspace_id,name,provider,monthly_amount,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`).bind(WS_OFF, WS_OFF, "ChatGPT", "openai", 315, TS, TS),
      env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`).bind(S_OFF, WS_OFF, U_OFF, WS_OFF, "2029-04-01", 5, "active", TS, TS),
      env.DB.prepare(`INSERT INTO payments (id,workspace_id,subscription_id,period,period_start,period_end,due_date,amount,status,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).bind(P_OFF, WS_OFF, S_OFF, P, `${P}-01`, `${P}-30`, `${P}-05`, 315, "paid", "user_slash", TS, TS),
    ]);
  });

  it("stays silent on verify when receipt_notify_verified is off (the default)", async () => {
    sent.length = 0;
    expect(await announcePaymentReceipt(env, { workspaceId: WS_OFF, kind: "verify", paymentIds: [P_OFF] }, base)).toBe(0);
    expect(sent).toHaveLength(0);
    // The slot must stay free: turning the setting on later has to be able to announce.
    expect(await claimNotification(env.DB, { workspaceId: WS_OFF, type: "receipt", period: P, userId: U_OFF, subscriptionId: S_OFF, event: "verify" })).toBe(true);
  });

  it("still announces a rejection when verify receipts are off", async () => {
    sent.length = 0;
    expect(await announcePaymentReceipt(env, { workspaceId: WS_OFF, kind: "reject", paymentIds: [P_OFF], reason: "重複" }, base)).toBe(1);
  });

  it("announces the verify once the workspace turns it on", async () => {
    await env.DB.prepare("UPDATE workspaces SET settings = ? WHERE id = ?")
      .bind(JSON.stringify({ discord_billing_channel_id: CHAN_OFF, receipt_notify_verified: true }), WS_OFF).run();
    // the probe claim above took this slot; give it back so the real call can win it
    await env.DB.prepare("DELETE FROM notification_logs WHERE workspace_id = ? AND type = 'receipt' AND event = 'verify'").bind(WS_OFF).run();
    sent.length = 0;
    expect(await announcePaymentReceipt(env, { workspaceId: WS_OFF, kind: "verify", paymentIds: [P_OFF] }, base)).toBe(1);
  });
});
