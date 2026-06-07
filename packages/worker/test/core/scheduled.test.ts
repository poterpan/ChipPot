import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { runDailyTasks, sendOverdueForPeriod } from "../../src/core/scheduled";
import type { Notifier, PlanOpenLine, OverduePerson } from "../../src/core/notify";
import { getObject, putObject } from "../../src/core/storage";

const TS = "2024-01-10T00:00:00.000Z";
const WS = 9010;
const CHAN = "chan-9010";
const ROLE = "role-9010";
const NOW = new Date("2026-07-04T16:30:00.000Z"); // = Taipei 2026-07-05 00:30 -> day 5, period 2026-07

const sent = { billing: [] as { period: string; lines: PlanOpenLine[] }[], overdue: [] as { period: string; people: OverduePerson[] }[] };
const notifier: Notifier = {
  async sendBillingOpened(_e, _ch, period, lines, _t) { sent.billing.push({ period, lines }); },
  async sendOverdue(_e, _ch, period, people, _t) { sent.overdue.push({ period, people }); },
};

beforeAll(async () => {
  // Tests must not depend on .dev.vars (CI / a fresh clone has none). The notifier here is a
  // fake, so this token only flips the env gate that lets runDailyTasks actually "send".
  (env as any).DISCORD_BOT_TOKEN = "test-bot-token";
  const settings = JSON.stringify({ discord_billing_channel_id: CHAN, overdue_days: 3, proof_retention_months: 24 });
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO workspaces (id,name,owner_id,channel_type,billing_day,settings,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(WS, "W", "o", "discord", 5, settings, TS, TS),
    env.DB.prepare(`INSERT INTO users (id,workspace_id,discord_id,display_name,created_at,updated_at) VALUES (?,?,?,?,?,?)`).bind(WS, WS, "d-9010", "Member", TS, TS),
    env.DB.prepare(`INSERT INTO plans (id,workspace_id,name,provider,monthly_amount,discord_role_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(WS, WS, "ChatGPT", "openai", 315, ROLE, TS, TS),
    env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(WS, WS, WS, WS, "2026-01-01", 5, TS, TS),
    // overdue pending payment (period 2026-06, due 2026-06-05)
    env.DB.prepare(`INSERT INTO payments (workspace_id,subscription_id,period,period_start,period_end,due_date,amount,status,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).bind(WS, WS, "2026-06", "2026-06-01", "2026-06-30", "2026-06-05", 315, "pending", "cron", TS, TS),
    // retention-eligible verified payment with proof (paid/verified in 2024, > 24mo before NOW)
    env.DB.prepare(`INSERT INTO payments (workspace_id,subscription_id,period,period_start,period_end,due_date,amount,status,has_proof,screenshot_key,paid_at,verified_at,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(WS, WS, "2024-01", "2024-01-01", "2024-01-31", "2024-01-05", 315, "verified", 1, "ret-key-9010", "2024-01-10T00:00:00.000Z", "2024-01-12T00:00:00.000Z", "user_web", TS, TS),
  ]);
  await putObject(env.BUCKET, "ret-key-9010", new Uint8Array([1, 2, 3]), "image/png");
});

describe("runDailyTasks", () => {
  it("creates period payment, sends billing-opened + overdue, runs retention", async () => {
    const s = await runDailyTasks(env, NOW, notifier);

    // payment for the current period created
    const p = await env.DB.prepare("SELECT status FROM payments WHERE subscription_id = ? AND period = '2026-07'").bind(WS).first<{ status: string }>();
    expect(p?.status).toBe("pending");
    expect(s.paymentsEnsured).toBeGreaterThanOrEqual(1);

    // billing-opened: one notice tagging the plan role
    expect(s.billingOpenedSent).toBe(1);
    expect(sent.billing.at(-1)?.lines.find((l) => l.plan_id === WS)?.role_id).toBe(ROLE);

    // overdue: the 2026-06 pending payment (30 days late) reminded as one batched message
    expect(s.overdueSent).toBe(1);
    const od = sent.overdue.at(-1)!;
    expect(od.period).toBe("2026-06");
    expect(od.people[0]).toMatchObject({ discord_id: "d-9010" });
    expect(od.people[0]!.lines.length).toBeGreaterThanOrEqual(1);

    // retention: the 2024 proof deleted
    expect(s.proofsDeleted).toBe(1);
    expect(await getObject(env.BUCKET, "ret-key-9010")).toBeNull();
    const ret = await env.DB.prepare("SELECT screenshot_key, proof_deleted_at, has_proof FROM payments WHERE subscription_id = ? AND period = '2024-01'").bind(WS).first<{ screenshot_key: string | null; proof_deleted_at: string | null; has_proof: number }>();
    expect(ret?.screenshot_key).toBeNull();
    expect(ret?.proof_deleted_at).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(ret?.has_proof).toBe(1); // history preserved
  });

  it("is idempotent: a second run sends no duplicate notifications", async () => {
    const before = { billing: sent.billing.length, overdue: sent.overdue.length };
    const s = await runDailyTasks(env, NOW, notifier);
    expect(s.billingOpenedSent).toBe(0);
    expect(s.overdueSent).toBe(0);
    expect(s.proofsDeleted).toBe(0);
    expect(sent.billing.length).toBe(before.billing);
    expect(sent.overdue.length).toBe(before.overdue);
  });
});

describe("sendOverdueForPeriod includes rejected payments", () => {
  it("force-resend lists a member whose payment was rejected (still owes)", async () => {
    // a member: a 2099-01 payment that the admin rejected → still unpaid.
    await env.DB.prepare(
      `INSERT INTO payments (workspace_id,subscription_id,period,period_start,period_end,due_date,amount,status,source,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(WS, WS, "2099-01", "2099-01-01", "2099-01-31", "2099-01-05", 315, "rejected", "user_slash", TS, TS).run();

    const before = sent.overdue.length;
    const count = await sendOverdueForPeriod(env, WS, "2099-01", notifier, { force: true });
    expect(count).toBe(1);
    expect(sent.overdue.length).toBe(before + 1);
    expect(sent.overdue.at(-1)!.people[0]).toMatchObject({ discord_id: "d-9010" });
  });
});
