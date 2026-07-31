import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { sendOverdueForPeriod } from "../../src/core/scheduled";
import type { Notifier, OverduePerson } from "../../src/core/notify";

const TS = "2026-05-01T00:00:00.000Z";
const WS = 9810;
const PLAN = 9810;
const USER_A = 9810, USER_B = 98101;
const SUB_A = 9810, SUB_B = 98101;
const CHAN = "chan-9810";
const PERIOD = "2098-06";
const EMPTY_PERIOD = "2098-07";

const sent: { people: OverduePerson[] }[] = [];
const notifier: Notifier = {
  async sendBillingOpened() {},
  async sendOverdue(_e, _ch, _p, people, _t) { sent.push({ people }); },
  async sendPaymentNudge() {},
};

beforeAll(async () => {
  (env as any).DISCORD_BOT_TOKEN = "test-bot-token";
  const settings = JSON.stringify({ discord_billing_channel_id: CHAN, overdue_days: 3 });
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO workspaces (id,name,owner_id,channel_type,billing_day,settings,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(WS, "W", "o", "discord", 1, settings, TS, TS),
    env.DB.prepare(`INSERT INTO users (id,workspace_id,discord_id,display_name,created_at,updated_at) VALUES (?,?,?,?,?,?)`).bind(USER_A, WS, "d-9810a", "A", TS, TS),
    env.DB.prepare(`INSERT INTO users (id,workspace_id,discord_id,display_name,created_at,updated_at) VALUES (?,?,?,?,?,?)`).bind(USER_B, WS, "d-9810b", "B", TS, TS),
    env.DB.prepare(`INSERT INTO plans (id,workspace_id,name,provider,monthly_amount,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`).bind(PLAN, WS, "ChatGPT", "openai", 315, TS, TS),
    env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(SUB_A, WS, USER_A, PLAN, "2098-06-01", 1, TS, TS),
    env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(SUB_B, WS, USER_B, PLAN, "2098-06-01", 1, TS, TS),
    // 兩張未繳帳單，due_date 在未來 → 都還沒超過 overdue_days
    env.DB.prepare(`INSERT INTO payments (workspace_id,subscription_id,period,period_start,period_end,due_date,amount,status,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).bind(WS, SUB_A, PERIOD, `${PERIOD}-01`, `${PERIOD}-30`, `${PERIOD}-01`, 315, "pending", "cron", TS, TS),
    env.DB.prepare(`INSERT INTO payments (workspace_id,subscription_id,period,period_start,period_end,due_date,amount,status,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).bind(WS, SUB_B, PERIOD, `${PERIOD}-01`, `${PERIOD}-30`, `${PERIOD}-01`, 315, "pending", "cron", TS, TS),
  ]);
});

describe("sendOverdueForPeriod 結果物件", () => {
  it("dry run 列出會被 @ 的人、不送出、並帶回 overdue_days", async () => {
    const before = sent.length;
    const r = await sendOverdueForPeriod(env, WS, PERIOD, notifier, { force: true, dryRun: true });
    expect(r.outcome).toBe("preview");
    expect(r.notified).toBe(0);
    expect(r.overdue_days).toBe(3);
    expect(r.people.map((p) => p.user_name).sort()).toEqual(["A", "B"]);
    expect(sent.length).toBe(before);
  });

  it("dry run 不會動到去重紀錄", async () => {
    // 預覽必須是唯讀的：force=true 的實際送出會先清 slot，dry run 不能有這個副作用。
    await sendOverdueForPeriod(env, WS, PERIOD, notifier, { force: true, dryRun: true });
    const n = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM notification_logs WHERE workspace_id = ? AND type = 'overdue' AND period = ?"
    ).bind(WS, PERIOD).first<{ n: number }>();
    expect(n!.n).toBe(0);
  });

  it("沒有未繳帳單的期別回 none_due", async () => {
    const r = await sendOverdueForPeriod(env, WS, EMPTY_PERIOD, notifier, { force: true, dryRun: true });
    expect(r).toMatchObject({ outcome: "none_due", notified: 0 });
    expect(r.people).toEqual([]);
  });

  it("force=false 時未到逾期天數的人不會被列入（cron 名單）", async () => {
    // due_date 是 2098-06-01、overdue_days=3 → 用 2098-06-02 當今天，還沒逾期
    const r = await sendOverdueForPeriod(env, WS, PERIOD, notifier, {
      force: false, dryRun: true, now: new Date("2098-06-02T00:00:00Z"),
    });
    expect(r).toMatchObject({ outcome: "none_due", notified: 0 });
  });

  it("實際送出後回報真實人數", async () => {
    const before = sent.length;
    const r = await sendOverdueForPeriod(env, WS, PERIOD, notifier, { force: true, dryRun: false });
    expect(r).toMatchObject({ outcome: "sent", notified: 2 });
    expect(sent.length).toBe(before + 1);
  });

  it("非 force 的第二次送出回 already_sent 而不是假的 sent", async () => {
    // 上一個 it 已經佔用 (ws, overdue, period) 的 slot；cron 再跑一次不能重送。
    const before = sent.length;
    const r = await sendOverdueForPeriod(env, WS, PERIOD, notifier, {
      force: false, dryRun: false, now: new Date("2098-06-30T00:00:00Z"),
    });
    expect(r).toMatchObject({ outcome: "already_sent", notified: 0 });
    expect(r.people.length).toBe(2); // 名單還是要帶回來，UI 才講得出「這 2 位已經催過了」
    expect(sent.length).toBe(before);
  });

  it("沒有 bot token 時回 no_bot_token 而不是假成功", async () => {
    const prev = (env as any).DISCORD_BOT_TOKEN;
    (env as any).DISCORD_BOT_TOKEN = "";
    const r = await sendOverdueForPeriod(env, WS, PERIOD, notifier, { force: true, dryRun: true });
    expect(r).toMatchObject({ outcome: "no_bot_token", notified: 0 });
    (env as any).DISCORD_BOT_TOKEN = prev;
  });

  it("沒有頻道設定時回 no_channel，並仍帶回 overdue_days", async () => {
    await env.DB.prepare("UPDATE workspaces SET settings = ? WHERE id = ?").bind(JSON.stringify({ overdue_days: 3 }), WS).run();
    const r = await sendOverdueForPeriod(env, WS, PERIOD, notifier, { force: true, dryRun: true });
    expect(r).toMatchObject({ outcome: "no_channel", notified: 0, overdue_days: 3 });
    await env.DB.prepare("UPDATE workspaces SET settings = ? WHERE id = ?")
      .bind(JSON.stringify({ discord_billing_channel_id: CHAN, overdue_days: 3 }), WS).run();
  });
});
