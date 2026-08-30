import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { sendMemberNudge } from "../../src/core/nudge";
import { claimNotification, type Notifier, type OverduePerson } from "../../src/core/notify";

// Fresh id band for this file: workspace/plan 9820, users 98201-98203, subs 98210-98212.
// (Storage is isolated per test FILE, so the band only has to be collision-free in here.)
const TS = "2026-05-01T00:00:00.000Z";
const WS = 9820;
const CHAN = "chan-9820";
const U_BOUND = 98201, U_BOUND2 = 98202, U_UNBOUND = 98203;
const S_1 = 98210, S_2 = 98211, S_3 = 98212;
const P = "2029-10";
const CLOSED = "2029-11"; // has bills but was never opened

const sent: { period: string; people: OverduePerson[]; kind: string }[] = [];
const notifier: Notifier = {
  async sendBillingOpened() { return true; },
  async sendOverdue() { return true; },
  async sendPaymentReceipt() { return true; },
  async sendPaymentNudge(_e, _ch, _ws, period, people, kind) { sent.push({ period, people, kind }); return true; },
};
// The Notifier contract is "a refused send is a false, never a throw" (core/notify.ts), so the
// failure fixture reports false rather than throwing.
const failing: Notifier = { ...notifier, async sendPaymentNudge() { return false; } };

const bill = (sub: number, period: string, amount: number) =>
  env.DB.prepare(`INSERT INTO payments (workspace_id,subscription_id,period,period_start,period_end,due_date,amount,status,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(WS, sub, period, `${period}-01`, `${period}-30`, `${period}-05`, amount, "pending", "cron", TS, TS);

beforeAll(async () => {
  (env as any).DISCORD_BOT_TOKEN = "test-bot-token";
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO workspaces (id,name,owner_id,channel_type,billing_day,settings,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(WS, "W", "o", "discord", 5, JSON.stringify({ discord_billing_channel_id: CHAN }), TS, TS),
    env.DB.prepare(`INSERT INTO users (id,workspace_id,discord_id,display_name,created_at,updated_at) VALUES (?,?,?,?,?,?)`).bind(U_BOUND, WS, "d-98201", "張三", TS, TS),
    env.DB.prepare(`INSERT INTO users (id,workspace_id,discord_id,display_name,created_at,updated_at) VALUES (?,?,?,?,?,?)`).bind(U_BOUND2, WS, "d-98202", "李四", TS, TS),
    env.DB.prepare(`INSERT INTO users (id,workspace_id,display_name,created_at,updated_at) VALUES (?,?,?,?,?)`).bind(U_UNBOUND, WS, "王五", TS, TS),
    env.DB.prepare(`INSERT INTO plans (id,workspace_id,name,provider,monthly_amount,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`).bind(WS, WS, "ChatGPT", "openai", 315, TS, TS),
    env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`).bind(S_1, WS, U_BOUND, WS, "2029-10-01", 5, "active", TS, TS),
    env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`).bind(S_2, WS, U_BOUND2, WS, "2029-10-01", 5, "active", TS, TS),
    env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`).bind(S_3, WS, U_UNBOUND, WS, "2029-10-01", 5, "active", TS, TS),
    bill(S_1, P, 315), bill(S_2, P, 251), bill(S_3, P, 315), bill(S_1, CLOSED, 315),
    env.DB.prepare(`INSERT INTO notification_logs (workspace_id,type,period,plan_id,user_id,subscription_id,event,sent_at) VALUES (?,?,?,?,?,?,?,?)`).bind(WS, "billing_opened", P, 0, 0, 0, "", TS),
  ]);
});

describe("sendMemberNudge", () => {
  it("nudges the bound members and reports the ones it cannot reach", async () => {
    sent.length = 0;
    const r = await sendMemberNudge(env, { workspaceId: WS, period: P, userIds: [U_BOUND, U_UNBOUND], kind: "added" }, notifier);
    expect(r).toMatchObject({ opened: true, notified: 1, skipped: 0, unbound: 1, unbound_names: ["王五"] });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.people.map((p) => p.user_id)).toEqual([U_BOUND]);
    expect(sent[0]!.kind).toBe("added");
  });

  it("does not @ the same member twice for the same period (P2-4)", async () => {
    sent.length = 0;
    const r = await sendMemberNudge(env, { workspaceId: WS, period: P, userIds: [U_BOUND], kind: "added" }, notifier);
    expect(r).toMatchObject({ notified: 0, skipped: 1 });
    expect(sent).toHaveLength(0);
  });

  it("force re-nudges deliberately (admin pressed the button)", async () => {
    sent.length = 0;
    const r = await sendMemberNudge(env, { workspaceId: WS, period: P, userIds: [U_BOUND], kind: "remind", force: true }, notifier);
    expect(r.notified).toBe(1);
    expect(sent[0]!.kind).toBe("remind");
  });

  it("says nothing and claims nothing when the period is not opened", async () => {
    sent.length = 0;
    const r = await sendMemberNudge(env, { workspaceId: WS, period: CLOSED, userIds: [U_BOUND], kind: "added" }, notifier);
    expect(r).toMatchObject({ opened: false, notified: 0 });
    expect(sent).toHaveLength(0);
    const rows = await env.DB.prepare("SELECT COUNT(*) c FROM notification_logs WHERE workspace_id=? AND type='nudge' AND period=?").bind(WS, CLOSED).first<{ c: number }>();
    expect(rows!.c).toBe(0);
  });

  it("skips members with nothing outstanding", async () => {
    sent.length = 0;
    await env.DB.prepare("UPDATE payments SET status='verified' WHERE subscription_id=? AND period=?").bind(S_2, P).run();
    const r = await sendMemberNudge(env, { workspaceId: WS, period: P, userIds: [U_BOUND2], kind: "added" }, notifier);
    expect(r.notified).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it("gives the slots back when the send fails", async () => {
    sent.length = 0;
    const fail = await sendMemberNudge(env, { workspaceId: WS, period: P, userIds: [U_BOUND], kind: "remind", force: true }, failing);
    expect(fail.notified).toBe(0);
    const retry = await sendMemberNudge(env, { workspaceId: WS, period: P, userIds: [U_BOUND], kind: "remind" }, notifier);
    expect(retry.notified).toBe(1);
  });

  // Same rule as core/receipt.ts: with nowhere to send, the slot must stay free, otherwise
  // configuring Discord later arrives to members who already count as nudged.
  it("does not claim a slot when there is no bot token", async () => {
    sent.length = 0;
    await env.DB.prepare("DELETE FROM notification_logs WHERE workspace_id=? AND type='nudge' AND period=? AND user_id=?").bind(WS, P, U_BOUND).run();
    const token = (env as any).DISCORD_BOT_TOKEN;
    delete (env as any).DISCORD_BOT_TOKEN;
    const r = await sendMemberNudge(env, { workspaceId: WS, period: P, userIds: [U_BOUND], kind: "remind" }, notifier);
    (env as any).DISCORD_BOT_TOKEN = token;
    expect(r).toMatchObject({ opened: true, notified: 0 });
    expect(sent).toHaveLength(0);
    const rows = await env.DB.prepare("SELECT COUNT(*) c FROM notification_logs WHERE workspace_id=? AND type='nudge' AND period=? AND user_id=?").bind(WS, P, U_BOUND).first<{ c: number }>();
    expect(rows!.c).toBe(0);
  });

  // #45 Codex finding 2: a missing transport must not read as "nobody needed notifying".
  it("names the reason and still reports who would have been reached", async () => {
    await env.DB.prepare("DELETE FROM notification_logs WHERE workspace_id=? AND type='nudge' AND period=?").bind(WS, P).run();
    const token = (env as any).DISCORD_BOT_TOKEN;
    delete (env as any).DISCORD_BOT_TOKEN;
    const r = await sendMemberNudge(env, { workspaceId: WS, period: P, userIds: [U_BOUND, U_UNBOUND], kind: "added" }, notifier);
    (env as any).DISCORD_BOT_TOKEN = token;

    expect(r.transport).toBe("no_bot_token");   // the real reason, not a silent zero
    expect(r.unbound).toBe(1);                  // computed BEFORE the transport bail-out
    expect(r.unbound_names).toEqual(["王五"]);
    expect(r.notified).toBe(0);
  });
});

/**
 * #45 Codex finding 1: a failed send must release only the row THIS call won. Releasing by key
 * instead lets a concurrent force delete a slot it does not own, which re-opens the duplicate the
 * dedup exists to prevent. Same defect #48 fixed in core/scheduled.ts.
 */
describe("failed send releases only its own slot", () => {
  it("does not delete a slot another call claimed in the meantime", async () => {
    const key = { workspaceId: WS, type: "nudge" as const, period: P, userId: U_BOUND };
    // Call A claims and is about to fail; simulate B replacing the row underneath it by clearing
    // and re-claiming, so the live row is B's, not A's.
    const failer: Notifier = {
      ...notifier,
      async sendPaymentNudge() {
        await env.DB.prepare("DELETE FROM notification_logs WHERE workspace_id=? AND type='nudge' AND period=? AND user_id=?")
          .bind(WS, P, U_BOUND).run();
        expect(await claimNotification(env.DB, key)).toBe(true); // this row now belongs to "B"
        return false; // ...and only now does A's send fail
      },
    };

    await env.DB.prepare("DELETE FROM notification_logs WHERE workspace_id=? AND type='nudge' AND period=?")
      .bind(WS, P).run();
    const r = await sendMemberNudge(env, { workspaceId: WS, period: P, userIds: [U_BOUND], kind: "remind", force: true }, failer);
    expect(r.notified).toBe(0);

    // B's slot must survive A's release: releasing by key would have deleted it.
    const left = await env.DB.prepare(
      "SELECT COUNT(*) c FROM notification_logs WHERE workspace_id=? AND type='nudge' AND period=? AND user_id=?"
    ).bind(WS, P, U_BOUND).first<{ c: number }>();
    expect(left!.c).toBe(1);
  });
});
