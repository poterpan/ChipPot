import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { sendOverdueForPeriod } from "../../src/core/scheduled";
import { importRoster } from "../../src/core/import";
import { listActiveSubscriptions } from "../../src/core/db";
import type { Notifier, OverduePerson } from "../../src/core/notify";

// 附卡 (#58): one payer, several accounts — each its own subscription carrying account_label /
// account_email. Bills and reminders stay on the payer; the label tells the lines apart; the email
// never leaves 後台; roster import leaves 附卡 subs alone.

const TS = "2026-05-01T00:00:00.000Z";
const WS = 9580;
const PLAN = 9580;
const PAYER = 9580, SOLO = 95801;
const SUB_MAIN = 9580, SUB_EXTRA = 95801, SUB_SOLO_EXTRA = 95802;
const PERIOD = "2097-06";

const sent: { people: OverduePerson[] }[] = [];
const notifier: Notifier = {
  async sendBillingOpened() { return true; },
  async sendOverdue(_e, _ch, _p, people, _t) { sent.push({ people }); return true; },
  async sendPaymentNudge() { return true; },
  async sendPaymentReceipt() { return true; },
};

const sub = (id: number, user: number, label: string | null, email: string | null) =>
  env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,account_label,account_email,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .bind(id, WS, user, PLAN, `${PERIOD}-01`, 1, label, email, TS, TS);
const bill = (subId: number) =>
  env.DB.prepare(`INSERT INTO payments (workspace_id,subscription_id,period,period_start,period_end,due_date,amount,status,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(WS, subId, PERIOD, `${PERIOD}-01`, `${PERIOD}-30`, `${PERIOD}-01`, 315, "pending", "cron", TS, TS);

beforeAll(async () => {
  (env as any).DISCORD_BOT_TOKEN = "test-bot-token";
  const settings = JSON.stringify({ discord_billing_channel_id: "chan-9580", overdue_days: 3 });
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO workspaces (id,name,owner_id,channel_type,billing_day,settings,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(WS, "W", "o", "discord", 1, settings, TS, TS),
    env.DB.prepare(`INSERT INTO plans (id,workspace_id,name,provider,monthly_amount,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`).bind(PLAN, WS, "ChatGPT", "openai", 315, TS, TS),
    env.DB.prepare(`INSERT INTO users (id,workspace_id,discord_id,display_name,email,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`).bind(PAYER, WS, "d-9580", "Payer", "payer@x.tw", TS, TS),
    env.DB.prepare(`INSERT INTO users (id,workspace_id,discord_id,display_name,email,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`).bind(SOLO, WS, "d-95801", "Solo", "solo@x.tw", TS, TS),
    sub(SUB_MAIN, PAYER, null, null),
    sub(SUB_EXTRA, PAYER, "帳號 2", "second@x.tw"),
    // Solo only holds an extra account — no sub of their own.
    sub(SUB_SOLO_EXTRA, SOLO, "帳號 2", null),
    bill(SUB_MAIN),
    bill(SUB_EXTRA),
  ]);
});

describe("附卡 member-facing lines", () => {
  it("overdue lists both of the payer's bills under the payer, label appended, email absent", async () => {
    const r = await sendOverdueForPeriod(env, WS, PERIOD, notifier, { force: true, dryRun: true });
    const payer = r.people.find((p) => p.user_id === PAYER)!;
    expect(payer.lines.map((l) => l.plan_name)).toEqual(["ChatGPT", "ChatGPT（帳號 2）"]);
    expect(payer.total).toBe(630);
    expect(JSON.stringify(r.people)).not.toContain("second@x.tw");
  });

  it("listActiveSubscriptions tells the two subscriptions apart", async () => {
    const subs = await listActiveSubscriptions(env.DB, WS, PAYER);
    expect(subs.map((s) => s.plan_name)).toEqual(["ChatGPT", "ChatGPT（帳號 2）"]);
  });
});

describe("附卡 and roster import", () => {
  it("FALSE pauses only the member's own sub, never the 附卡", async () => {
    const d = await importRoster(env, WS, [{ name: "Payer", email: "payer@x.tw", plans: [], plansOff: ["ChatGPT"] }], { startDate: `${PERIOD}-01`, dryRun: false });
    expect(d.subs_paused.map((s) => s.subscription_id)).toEqual([SUB_MAIN]);
    const extra = await env.DB.prepare("SELECT status FROM subscriptions WHERE id = ?").bind(SUB_EXTRA).first<{ status: string }>();
    expect(extra!.status).toBe("active");
  });

  it("a 附卡 does not satisfy a TRUE: the member's own sub is added", async () => {
    const d = await importRoster(env, WS, [{ name: "Solo", email: "solo@x.tw", plans: ["ChatGPT"], plansOff: [] }], { startDate: `${PERIOD}-01`, dryRun: true });
    expect(d.subs_added.map((s) => s.user_name)).toEqual(["Solo"]);
    expect(d.subs_skipped).toBe(0);
  });
});
