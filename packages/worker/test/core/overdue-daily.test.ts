import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { runDailyTasks, sendOverdueForPeriod } from "../../src/core/scheduled";
import type { Notifier, OverduePerson } from "../../src/core/notify";

/**
 * #48 每日催繳: the overdue reminder must fire once per DAY (not once per period) until
 * everyone has paid. The dedup slot for 'overdue' is keyed on (workspace, period, day), so
 * consecutive cron runs keep reminding while any bill is still pending/rejected, and stop
 * the moment the period has no unpaid bills left.
 */

const TS = "2026-05-01T00:00:00.000Z";
const CHAN = "chan-9890";

const sent = { overdue: [] as { period: string; people: OverduePerson[] }[] };
const notifier: Notifier = {
  async sendBillingOpened() { return true; },
  async sendOverdue(_e, _ch, period, people, _t) { sent.overdue.push({ period, people }); return true; },
  async sendPaymentNudge() { return true; },
};

/** Seed a workspace + one member + one unpaid bill in `period`, due on day 5 of that month. */
async function seedUnpaid(wsId: number, period: string) {
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO workspaces (id,name,owner_id,channel_type,billing_day,settings,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`)
      .bind(wsId, "W", "o", "discord", 5, JSON.stringify({ discord_billing_channel_id: CHAN, overdue_days: 3, proof_retention_months: 24 }), TS, TS),
    env.DB.prepare(`INSERT INTO users (id,workspace_id,discord_id,display_name,created_at,updated_at) VALUES (?,?,?,?,?,?)`)
      .bind(wsId, wsId, `d-${wsId}`, "M", TS, TS),
    env.DB.prepare(`INSERT INTO plans (id,workspace_id,name,provider,monthly_amount,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`)
      .bind(wsId, wsId, "ChatGPT", "openai", 315, TS, TS),
    env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`)
      .bind(wsId, wsId, wsId, wsId, `${period}-01`, 5, TS, TS),
    env.DB.prepare(`INSERT INTO payments (workspace_id,subscription_id,period,period_start,period_end,due_date,amount,status,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(wsId, wsId, period, `${period}-01`, `${period}-31`, `${period}-05`, 315, "pending", "cron", TS, TS),
  ]);
}

beforeAll(async () => {
  (env as any).DISCORD_BOT_TOKEN = "test-bot-token";
  // Three independent periods so each test can mutate its own without touching the others.
  await seedUnpaid(9890, "2028-05");
  await seedUnpaid(9891, "2028-06");
  await seedUnpaid(9892, "2028-07");
  await seedUnpaid(9893, "2028-11"); // cron integration workspace
});

describe("#48 每日催繳", () => {
  it("逾期成員未繳時，隔天會再催一次（每日一則，而非每期一則）", async () => {
    // due 2028-05-05, overdue_days 3 → overdue from 05-08.
    const r1 = await sendOverdueForPeriod(env, 9890, "2028-05", notifier, { force: false, now: new Date("2028-05-10T00:00:00Z") });
    expect(r1).toMatchObject({ outcome: "sent", notified: 1 });

    const r2 = await sendOverdueForPeriod(env, 9890, "2028-05", notifier, { force: false, now: new Date("2028-05-11T00:00:00Z") });
    expect(r2).toMatchObject({ outcome: "sent", notified: 1 });
  });

  it("同一天只發一則（同日重複觸發去重）", async () => {
    const day = new Date("2028-06-12T00:00:00Z");
    const first = await sendOverdueForPeriod(env, 9891, "2028-06", notifier, { force: false, now: day });
    expect(first).toMatchObject({ outcome: "sent", notified: 1 });

    const second = await sendOverdueForPeriod(env, 9891, "2028-06", notifier, { force: false, now: day });
    expect(second).toMatchObject({ outcome: "already_sent", notified: 0 });
    expect(second.people.length).toBe(1); // 名單仍帶回，UI 才講得出「已經催過」
  });

  it("全部繳完後不再催（無 pending/rejected）", async () => {
    await env.DB.prepare("UPDATE payments SET status = 'paid' WHERE workspace_id = ? AND period = ?").bind(9892, "2028-07").run();
    const r = await sendOverdueForPeriod(env, 9892, "2028-07", notifier, { force: false, now: new Date("2028-07-13T00:00:00Z") });
    expect(r).toMatchObject({ outcome: "none_due", notified: 0 });
  });

  it("每日 cron 對同一期別連續兩天都計入 overdueSent", async () => {
    // period 2028-11, due 2028-11-05. Both runs land past overdue_days and on distinct days.
    // runDailyTasks sweeps every workspace in the DB, so count only the 2028-11 messages.
    const forNov = () => sent.overdue.filter((m) => m.period === "2028-11").length;

    const before = forNov();
    const s1 = await runDailyTasks(env, new Date("2028-11-09T16:30:00.000Z"), notifier); // Taipei 11-10
    expect(forNov()).toBe(before + 1);
    expect(s1.overdueSent).toBeGreaterThanOrEqual(1);

    const s2 = await runDailyTasks(env, new Date("2028-11-10T16:30:00.000Z"), notifier); // Taipei 11-11
    expect(forNov()).toBe(before + 2);
    expect(s2.overdueSent).toBeGreaterThanOrEqual(1);
  });
});
