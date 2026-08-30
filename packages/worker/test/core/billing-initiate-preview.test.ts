import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { previewBillingInitiate, initiateBillingOpened } from "../../src/core/billing";
import type { Notifier } from "../../src/core/notify";

const TS = "2026-05-01T00:00:00.000Z";
const WS = 9830;
const PLAN_A = 9830, PLAN_B = 98301, PLAN_C = 98302;
const USER_A = 9830, USER_B = 98301, USER_C = 98302;
const SUB_A = 9830, SUB_B = 98301, SUB_C = 98302;
const CHAN = "chan-9830";
const PERIOD = "2096-04";

const notifier: Notifier = { async sendBillingOpened() { return true; }, async sendOverdue() { return true; }, async sendPaymentNudge() { return true; }, async sendPaymentReceipt() { return true; } };

beforeAll(async () => {
  (env as any).DISCORD_BOT_TOKEN = "test-bot-token";
  const settings = JSON.stringify({ discord_billing_channel_id: CHAN });
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO workspaces (id,name,owner_id,channel_type,billing_day,settings,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(WS, "W", "o", "discord", 1, settings, TS, TS),
    env.DB.prepare(`INSERT INTO users (id,workspace_id,display_name,created_at,updated_at) VALUES (?,?,?,?,?)`).bind(USER_A, WS, "A", TS, TS),
    env.DB.prepare(`INSERT INTO users (id,workspace_id,display_name,created_at,updated_at) VALUES (?,?,?,?,?)`).bind(USER_B, WS, "B", TS, TS),
    env.DB.prepare(`INSERT INTO plans (id,workspace_id,name,provider,monthly_amount,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`).bind(PLAN_A, WS, "ChatGPT", "openai", 315, TS, TS),
    env.DB.prepare(`INSERT INTO plans (id,workspace_id,name,provider,monthly_amount,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`).bind(PLAN_B, WS, "Claude", "anthropic", 251, TS, TS),
    env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(SUB_A, WS, USER_A, PLAN_A, "2096-04-01", 1, TS, TS),
    env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(SUB_B, WS, USER_B, PLAN_B, "2096-04-01", 1, TS, TS),
    // SUB_B 已經有一張 pending 帳單（舊價 251），SUB_A 沒有
    env.DB.prepare(`INSERT INTO payments (workspace_id,subscription_id,period,period_start,period_end,due_date,amount,status,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).bind(WS, SUB_B, PERIOD, `${PERIOD}-01`, `${PERIOD}-30`, `${PERIOD}-01`, 251, "pending", "cron", TS, TS),
  ]);
});

describe("previewBillingInitiate", () => {
  const amounts = [{ plan_id: PLAN_A, amount: 400 }, { plan_id: PLAN_B, amount: 300 }];

  it("列出將建立／改價的帳單與定價 before→after，且完全不寫入", async () => {
    const p = await previewBillingInitiate(env, WS, PERIOD, { amounts });
    expect(p.opened).toBe(false);
    expect(p.will_notify).toBe(true);
    expect(p.notify_reason).toBe("ok");
    expect(p.plan_changes).toEqual([
      { plan_id: PLAN_A, plan_name: "ChatGPT", from: 315, to: 400 },
      { plan_id: PLAN_B, plan_name: "Claude", from: 251, to: 300 },
    ]);
    expect(p.create.map((c) => c.user_name)).toEqual(["A"]);   // SUB_A 還沒有帳單
    expect(p.create[0]!.amount).toBe(400);                     // 用新價建立
    expect(p.reprice.map((r) => [r.user_name, r.from, r.to])).toEqual([["B", 251, 300]]);
    expect(p.frozen_count).toBe(0);

    // 預覽是純讀取
    const plan = await env.DB.prepare("SELECT monthly_amount FROM plans WHERE id=?").bind(PLAN_A).first<{ monthly_amount: number }>();
    expect(plan!.monthly_amount).toBe(315);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM payments WHERE workspace_id=? AND period=?").bind(WS, PERIOD).first<{ n: number }>();
    expect(n!.n).toBe(1);
  });

  it("預覽的筆數與實際套用回報的筆數完全一致", async () => {
    const p = await previewBillingInitiate(env, WS, PERIOD, { amounts });
    const r = await initiateBillingOpened(env, WS, PERIOD, { amounts }, "owner@x", notifier);
    expect(r.createdPayments).toBe(p.create.length);
    expect(r.updatedPayments).toBe(p.reprice.length);
    expect(r.updatedPlans).toBe(p.plan_changes.length);
  });

  it("已開繳的期別預覽為 already_sent（不會再發通知）", async () => {
    const p = await previewBillingInitiate(env, WS, PERIOD, { amounts });
    expect(p.opened).toBe(true);
    expect(p.will_notify).toBe(false);
    expect(p.notify_reason).toBe("already_sent");
    expect(p.plan_changes).toEqual([]); // 價格已在上一步寫入，現在沒有差異
  });

  it("已繳待驗的帳單算進 frozen_count，不出現在 reprice", async () => {
    await env.DB.prepare("UPDATE payments SET status='paid' WHERE workspace_id=? AND period=? AND subscription_id=?")
      .bind(WS, PERIOD, SUB_B).run();
    const p = await previewBillingInitiate(env, WS, PERIOD, { amounts: [{ plan_id: PLAN_B, amount: 999 }] });
    expect(p.frozen_count).toBe(1);
    expect(p.reprice.find((r) => r.subscription_id === SUB_B)).toBeUndefined();
  });

  it("沒被確認金額的方案，預覽用現有定價建帳單，套用後金額一致", async () => {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO users (id,workspace_id,display_name,created_at,updated_at) VALUES (?,?,?,?,?)`).bind(USER_C, WS, "C", TS, TS),
      env.DB.prepare(`INSERT INTO plans (id,workspace_id,name,provider,monthly_amount,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`).bind(PLAN_C, WS, "Gemini", "google", 150, TS, TS),
      env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(SUB_C, WS, USER_C, PLAN_C, "2096-04-01", 1, TS, TS),
    ]);
    const only_a = [{ plan_id: PLAN_A, amount: 400 }]; // PLAN_C 不在確認清單裡

    const p = await previewBillingInitiate(env, WS, PERIOD, { amounts: only_a });
    expect(p.create.map((c) => [c.user_name, c.amount])).toEqual([["C", 150]]);

    const r = await initiateBillingOpened(env, WS, PERIOD, { amounts: only_a }, "owner@x", notifier);
    expect(r.createdPayments).toBe(p.create.length);
    expect(r.updatedPayments).toBe(p.reprice.length);
    expect(r.updatedPlans).toBe(p.plan_changes.length);
    const bill = await env.DB.prepare("SELECT amount FROM payments WHERE subscription_id=? AND period=?")
      .bind(SUB_C, PERIOD).first<{ amount: number }>();
    expect(bill!.amount).toBe(p.create[0]!.amount); // 預覽報的價就是真的建出來的價
  });
});
