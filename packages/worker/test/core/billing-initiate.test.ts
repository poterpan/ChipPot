import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { initiateBillingOpened } from "../../src/core/billing";
import { claimNotification, type Notifier, type PlanOpenLine } from "../../src/core/notify";

const TS = "2026-05-01T00:00:00.000Z";
const WS = 9022;
const PLAN_A = 9022, PLAN_B = 90221;
const SUB_A = 9022, SUB_B = 90221;
const CHAN = "chan-9022";
const PERIOD = "2027-05";

const sent: { period: string; lines: PlanOpenLine[] }[] = [];
const notifier: Notifier = {
  async sendBillingOpened(_e, _ch, period, lines, _t) { sent.push({ period, lines }); },
  async sendOverdue() {},
};

beforeAll(async () => {
  // Tests must not depend on .dev.vars (CI / a fresh clone has none). The notifier here is a
  // fake, so this token only flips the env gate that lets initiateBillingOpened actually "send".
  (env as any).DISCORD_BOT_TOKEN = "test-bot-token";
  const settings = JSON.stringify({ discord_billing_channel_id: CHAN });
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO workspaces (id,name,owner_id,channel_type,billing_day,settings,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(WS, "W", "o", "discord", 5, settings, TS, TS),
    env.DB.prepare(`INSERT INTO users (id,workspace_id,display_name,created_at,updated_at) VALUES (?,?,?,?,?)`).bind(WS, WS, "U", TS, TS),
    env.DB.prepare(`INSERT INTO plans (id,workspace_id,name,provider,monthly_amount,discord_role_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(PLAN_A, WS, "ChatGPT", "openai", 315, "role-a", TS, TS),
    env.DB.prepare(`INSERT INTO plans (id,workspace_id,name,provider,monthly_amount,discord_role_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(PLAN_B, WS, "Claude", "anthropic", 251, "role-b", TS, TS),
    env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(SUB_A, WS, WS, PLAN_A, "2027-05-01", 5, TS, TS),
    env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(SUB_B, WS, WS, PLAN_B, "2027-05-01", 5, TS, TS),
    // an already-paid payment for SUB_A: its amount must NOT be touched by initiate.
    env.DB.prepare(`INSERT INTO payments (workspace_id,subscription_id,period,period_start,period_end,due_date,amount,status,paid_at,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).bind(WS, SUB_A, PERIOD, `${PERIOD}-01`, `${PERIOD}-31`, `${PERIOD}-05`, 315, "paid", TS, "user_slash", TS, TS),
  ]);
});

describe("initiateBillingOpened", () => {
  it("updates prices + pending amounts, freezes paid rows, notifies, claims the slot", async () => {
    const r = await initiateBillingOpened(
      env, WS, PERIOD,
      { amounts: [{ plan_id: PLAN_A, amount: 400 }, { plan_id: PLAN_B, amount: 300 }] },
      "owner@x", notifier
    );
    expect(r.sent).toBe(true);

    // plan prices updated
    const pa = await env.DB.prepare("SELECT monthly_amount FROM plans WHERE id=?").bind(PLAN_A).first<{ monthly_amount: number }>();
    expect(pa?.monthly_amount).toBe(400);

    // SUB_A's PAID payment is frozen at 315; SUB_B's pending payment becomes 300
    const paidRow = await env.DB.prepare("SELECT amount,status FROM payments WHERE subscription_id=? AND period=?").bind(SUB_A, PERIOD).first<{ amount: number; status: string }>();
    expect(paidRow).toMatchObject({ amount: 315, status: "paid" });
    const pendRow = await env.DB.prepare("SELECT amount,status FROM payments WHERE subscription_id=? AND period=?").bind(SUB_B, PERIOD).first<{ amount: number; status: string }>();
    expect(pendRow).toMatchObject({ amount: 300, status: "pending" });

    // notice tagged both plan roles
    expect(sent.at(-1)?.lines.map((l) => l.role_id).sort()).toEqual(["role-a", "role-b"]);
  });

  it("a manual initiate claims the billing_opened slot so cron would skip", async () => {
    // slot already claimed by the prior test -> claimNotification now returns false
    const won = await claimNotification(env.DB, { workspaceId: WS, type: "billing_opened", period: PERIOD });
    expect(won).toBe(false);
  });

  it("force re-sends even after the slot was already claimed", async () => {
    await initiateBillingOpened(env, WS, "2027-07", { amounts: [] }, "owner@x", notifier);
    const before = sent.length;
    const r2 = await initiateBillingOpened(env, WS, "2027-07", { amounts: [] }, "owner@x", notifier);
    expect(r2.sent).toBe(false);
    const r3 = await initiateBillingOpened(env, WS, "2027-07", { amounts: [] }, "owner@x", notifier, { force: true });
    expect(r3.sent).toBe(true);
    expect(sent.length).toBe(before + 1);
  });
});
