import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { resendBillingOpenedNotice } from "../../src/core/billing";
import { claimNotification, type Notifier, type PlanOpenLine } from "../../src/core/notify";

const TS = "2026-05-01T00:00:00.000Z";
const WS = 9800;
const PLAN = 9800, PLAN_OFF = 98001;
const SUB = 9800;
const USER = 9800, USER_LATE = 98001;
const CHAN = "chan-9800";
const OPENED = "2027-03";   // 有 billing_opened 紀錄
const UNOPENED = "2027-04"; // 沒有

const sent: { period: string; lines: PlanOpenLine[] }[] = [];
const notifier: Notifier = {
  async sendBillingOpened(_e, _ch, period, lines, _t) { sent.push({ period, lines }); return true; },
  async sendOverdue() { return true; },
  async sendPaymentNudge() { return true; },
  async sendPaymentReceipt() { return true; },
};

beforeAll(async () => {
  (env as any).DISCORD_BOT_TOKEN = "test-bot-token";
  const settings = JSON.stringify({ discord_billing_channel_id: CHAN });
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO workspaces (id,name,owner_id,channel_type,billing_day,settings,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(WS, "W", "o", "discord", 1, settings, TS, TS),
    env.DB.prepare(`INSERT INTO users (id,workspace_id,display_name,created_at,updated_at) VALUES (?,?,?,?,?)`).bind(USER, WS, "U", TS, TS),
    env.DB.prepare(`INSERT INTO users (id,workspace_id,display_name,created_at,updated_at) VALUES (?,?,?,?,?)`).bind(USER_LATE, WS, "Late", TS, TS),
    env.DB.prepare(`INSERT INTO plans (id,workspace_id,name,provider,monthly_amount,discord_role_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(PLAN, WS, "ChatGPT", "openai", 315, "role-a", TS, TS),
    // 停用的方案不該出現在公告名單裡
    env.DB.prepare(`INSERT INTO plans (id,workspace_id,name,provider,monthly_amount,discord_role_id,active,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`).bind(PLAN_OFF, WS, "Off", "openai", 100, null, 0, TS, TS),
    env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(SUB, WS, USER, PLAN, "2027-03-01", 1, TS, TS),
  ]);
  await claimNotification(env.DB, { workspaceId: WS, type: "billing_opened", period: OPENED });
});

describe("resendBillingOpenedNotice", () => {
  it("拒絕未開繳的期別，且不發送任何訊息", async () => {
    const before = sent.length;
    const r = await resendBillingOpenedNotice(env, WS, UNOPENED, notifier, { dryRun: false });
    expect(r.outcome).toBe("not_opened");
    expect(r.sent).toBe(false);
    expect(sent.length).toBe(before);
  });

  it("dry run 回傳公告名單但不發送", async () => {
    const before = sent.length;
    const r = await resendBillingOpenedNotice(env, WS, OPENED, notifier, { dryRun: true });
    expect(r.outcome).toBe("preview");
    expect(r.sent).toBe(false);
    expect(r.lines.map((l) => l.plan_name)).toEqual(["ChatGPT"]); // 停用方案不入列
    expect(sent.length).toBe(before);
  });

  it("重發會送出訊息、更新 sent_at，且 marker 全程存在", async () => {
    // 先把 sent_at 壓成一個固定的舊值，重發後才能斷言「真的變新」而不是靠同一毫秒的巧合。
    const STALE = "2020-01-01T00:00:00.000Z";
    await env.DB.prepare(
      "UPDATE notification_logs SET sent_at = ? WHERE workspace_id = ? AND type = 'billing_opened' AND period = ?"
    ).bind(STALE, WS, OPENED).run();

    const before = sent.length;
    const r = await resendBillingOpenedNotice(env, WS, OPENED, notifier, { dryRun: false });
    expect(r.outcome).toBe("sent");
    expect(r.sent).toBe(true);
    expect(sent.length).toBe(before + 1);
    // 期別仍然只有一列 billing_opened，且 sent_at 已更新（不是 delete + re-insert）
    const rows = await env.DB.prepare(
      "SELECT COUNT(*) AS n, MAX(sent_at) AS sent_at FROM notification_logs WHERE workspace_id = ? AND type = 'billing_opened' AND period = ?"
    ).bind(WS, OPENED).first<{ n: number; sent_at: string }>();
    expect(rows!.n).toBe(1);
    expect(rows!.sent_at > STALE).toBe(true);
  });

  it("重發不會為後來加入的成員建立帳單", async () => {
    await env.DB.prepare(
      `INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`
    ).bind(98002, WS, USER_LATE, PLAN, "2027-03-01", 1, TS, TS).run();
    await resendBillingOpenedNotice(env, WS, OPENED, notifier, { dryRun: false });
    const n = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM payments WHERE workspace_id = ? AND period = ?"
    ).bind(WS, OPENED).first<{ n: number }>();
    expect(n!.n).toBe(0); // 重發只是重貼公告
  });

  it("沒有頻道設定時回報 no_channel 而不是假成功", async () => {
    await env.DB.prepare("UPDATE workspaces SET settings = ? WHERE id = ?").bind(JSON.stringify({}), WS).run();
    const r = await resendBillingOpenedNotice(env, WS, OPENED, notifier, { dryRun: false });
    expect(r).toMatchObject({ outcome: "no_channel", sent: false });
    await env.DB.prepare("UPDATE workspaces SET settings = ? WHERE id = ?").bind(JSON.stringify({ discord_billing_channel_id: CHAN }), WS).run();
  });
});
