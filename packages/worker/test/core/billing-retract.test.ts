import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { ensurePeriodPayment, reconcilePeriodBills, retractPeriodBilling } from "../../src/core/billing";

// Fresh id band for this file: workspace/plan 9700, users/subs 970xx, proof keys "proof-9700*".
// (Bands 9xxx up to 9599 and 90xxx/93xxx/94xxx are taken by the other suites.)
const TS = "2026-05-01T00:00:00.000Z";
const WS = 9700, PLAN = 9700;
const P = "2027-11";        // the opened period we retract
const P_NEXT = "2027-12";   // a neighbouring opened period that must survive untouched
const U = 97001;
const S_PEND = 97001, S_REJ = 97002, S_PAID = 97003, S_VER = 97004, S_STALE = 97005;

beforeAll(async () => {
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO workspaces (id,name,owner_id,channel_type,billing_day,settings,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(WS,"W","o","discord",5,"{}",TS,TS),
    env.DB.prepare(`INSERT INTO plans (id,workspace_id,name,provider,monthly_amount,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`).bind(PLAN,WS,"GPT","openai",320,TS,TS),
    env.DB.prepare(`INSERT INTO users (id,workspace_id,display_name,discord_id,created_at,updated_at) VALUES (?,?,?,?,?,?)`).bind(U,WS,"成員","disc-9700",TS,TS),
    env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`).bind(S_PEND,WS,U,PLAN,"2027-01-01",5,"active",TS,TS),
    env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`).bind(S_REJ,WS,U,PLAN,"2027-01-01",5,"active",TS,TS),
    env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`).bind(S_PAID,WS,U,PLAN,"2027-01-01",5,"active",TS,TS),
    env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`).bind(S_VER,WS,U,PLAN,"2027-01-01",5,"active",TS,TS),
    // cancelled sub with a pending bill: retract drops it too (unlike reconcile, roster status is irrelevant)
    env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`).bind(S_STALE,WS,U,PLAN,"2027-01-01",5,"cancelled",TS,TS),
    env.DB.prepare(`INSERT INTO notification_logs (workspace_id,type,period,plan_id,user_id,subscription_id,sent_at) VALUES (?,?,?,?,?,?,?)`).bind(WS,"billing_opened",P,0,0,0,TS),
    env.DB.prepare(`INSERT INTO notification_logs (workspace_id,type,period,plan_id,user_id,subscription_id,sent_at) VALUES (?,?,?,?,?,?,?)`).bind(WS,"billing_opened",P_NEXT,0,0,0,TS),
    env.DB.prepare(`INSERT INTO payments (workspace_id,subscription_id,period,period_start,period_end,due_date,amount,status,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).bind(WS,S_PEND,P,`${P}-01`,`${P}-30`,`${P}-05`,320,"pending","cron",TS,TS),
    // rejected bill carrying a proof that only it references → orphan, must be swept from R2
    env.DB.prepare(`INSERT INTO payments (workspace_id,subscription_id,period,period_start,period_end,due_date,amount,status,source,screenshot_key,has_proof,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(WS,S_REJ,P,`${P}-01`,`${P}-30`,`${P}-05`,320,"rejected","user_slash","proof-9700-orphan",1,TS,TS),
    // paid bill sharing a proof key with the verified one → still referenced after the retract, must survive
    env.DB.prepare(`INSERT INTO payments (workspace_id,subscription_id,period,period_start,period_end,due_date,amount,status,source,screenshot_key,has_proof,paid_at,payment_note,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(WS,S_PAID,P,`${P}-01`,`${P}-30`,`${P}-05`,315,"paid","user_web","proof-9700-keep",1,TS,"轉帳末五碼 12345",TS,TS),
    env.DB.prepare(`INSERT INTO payments (workspace_id,subscription_id,period,period_start,period_end,due_date,amount,status,source,screenshot_key,has_proof,verified_by,verified_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(WS,S_VER,P,`${P}-01`,`${P}-30`,`${P}-05`,315,"verified","admin_manual","proof-9700-keep",1,"owner@example.com",TS,TS,TS),
    env.DB.prepare(`INSERT INTO payments (workspace_id,subscription_id,period,period_start,period_end,due_date,amount,status,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).bind(WS,S_STALE,P,`${P}-01`,`${P}-30`,`${P}-05`,320,"pending","cron",TS,TS),
    // next period's pending bill: proves the retract is scoped to ONE period
    env.DB.prepare(`INSERT INTO payments (workspace_id,subscription_id,period,period_start,period_end,due_date,amount,status,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).bind(WS,S_PEND,P_NEXT,`${P_NEXT}-01`,`${P_NEXT}-31`,`${P_NEXT}-05`,320,"pending","cron",TS,TS),
    env.DB.prepare(`INSERT INTO upload_tokens (token_hash,workspace_id,user_id,period,subscription_id,expires_at,created_at) VALUES (?,?,?,?,?,?,?)`).bind("h-9700-pend",WS,U,P,S_PEND,TS,TS),
    env.DB.prepare(`INSERT INTO upload_tokens (token_hash,workspace_id,user_id,period,subscription_id,expires_at,created_at) VALUES (?,?,?,?,?,?,?)`).bind("h-9700-paid",WS,U,P,S_PAID,TS,TS),
  ]);
  await env.BUCKET.put("proof-9700-orphan", "img");
  await env.BUCKET.put("proof-9700-keep", "img");
});

const countPayments = async (period: string) =>
  (await env.DB.prepare("SELECT COUNT(*) c FROM payments WHERE workspace_id=? AND period=?").bind(WS, period).first<{ c: number }>())!.c;
const countOpenedLogs = async (period: string) =>
  (await env.DB.prepare("SELECT COUNT(*) c FROM notification_logs WHERE workspace_id=? AND type='billing_opened' AND period=?").bind(WS, period).first<{ c: number }>())!.c;

describe("retractPeriodBilling", () => {
  it("is a no-op for a period that was never opened", async () => {
    const r = await retractPeriodBilling(env, WS, "2099-01", { dryRun: false });
    expect(r.opened).toBe(false);
    expect(r.removed).toEqual([]);
    expect(r.frozen_count).toBe(0);
  });

  it("dryRun lists pending/rejected as removed, counts paid/verified frozen, and writes nothing", async () => {
    const r = await retractPeriodBilling(env, WS, P, { dryRun: true });
    expect(r.opened).toBe(true);
    expect(new Set(r.removed.map((x) => x.subscription_id))).toEqual(new Set([S_PEND, S_REJ, S_STALE]));
    expect(r.frozen_count).toBe(2);
    expect(r.removed.every((x) => x.user_name === "成員" && x.plan_name === "GPT")).toBe(true);

    expect(await countPayments(P)).toBe(5);
    expect(await countOpenedLogs(P)).toBe(1);
    const tokens = (await env.DB.prepare("SELECT COUNT(*) c FROM upload_tokens WHERE workspace_id=? AND period=?").bind(WS, P).first<{ c: number }>())!.c;
    expect(tokens).toBe(2);
    expect(await env.BUCKET.get("proof-9700-orphan")).not.toBeNull();
  });

  it("apply deletes pending/rejected + the orphaned proof, keeps paid/verified whole, clears the marker", async () => {
    const r = await retractPeriodBilling(env, WS, P, { dryRun: false });
    expect(r.opened).toBe(true);
    expect(r.removed).toHaveLength(3);
    expect(r.frozen_count).toBe(2);

    const rows = (await env.DB.prepare("SELECT subscription_id sid, status, amount, screenshot_key, has_proof, source, payment_note, verified_by FROM payments WHERE workspace_id=? AND period=?")
      .bind(WS, P).all<{ sid: number; status: string; amount: number; screenshot_key: string | null; has_proof: number; source: string; payment_note: string | null; verified_by: string | null }>()).results;
    const bySub = new Map(rows.map((x) => [x.sid, x]));
    expect(rows).toHaveLength(2);
    expect(bySub.has(S_PEND)).toBe(false);
    expect(bySub.has(S_REJ)).toBe(false);
    expect(bySub.has(S_STALE)).toBe(false);
    // frozen rows survive with every field intact (a retract must never rewrite settled money)
    expect(bySub.get(S_PAID)).toMatchObject({ status: "paid", amount: 315, screenshot_key: "proof-9700-keep", has_proof: 1, source: "user_web", payment_note: "轉帳末五碼 12345" });
    expect(bySub.get(S_VER)).toMatchObject({ status: "verified", amount: 315, verified_by: "owner@example.com" });

    expect(await env.BUCKET.get("proof-9700-orphan")).toBeNull();  // last reference gone → swept
    expect(await env.BUCKET.get("proof-9700-keep")).not.toBeNull(); // still referenced by the frozen rows
    const tok = await env.DB.prepare("SELECT token_hash FROM upload_tokens WHERE workspace_id=? AND period=?").bind(WS, P).all<{ token_hash: string }>();
    expect(tok.results.map((t) => t.token_hash)).toEqual(["h-9700-paid"]); // only the removed subs' tokens are dropped
    expect(await countOpenedLogs(P)).toBe(0); // period is "unopened" again

    // scoped to one period: the neighbouring period keeps its bill AND its opened marker
    expect(await countPayments(P_NEXT)).toBe(1);
    expect(await countOpenedLogs(P_NEXT)).toBe(1);
  });

  it("leaves the period unopened, so reconcile no longer refills it", async () => {
    const d = await reconcilePeriodBills(env, WS, P, { dryRun: false });
    expect(d.opened).toBe(false);
    expect(d.add).toEqual([]);
    expect(await countPayments(P)).toBe(2); // still just the two frozen bills
  });

  it("re-opening the period bills the cleared subs again without duplicating the frozen ones", async () => {
    await env.DB.prepare(`INSERT INTO notification_logs (workspace_id,type,period,plan_id,user_id,subscription_id,sent_at) VALUES (?,?,?,?,?,?,?)`)
      .bind(WS, "billing_opened", P, 0, 0, 0, TS).run();
    const active = (await env.DB.prepare("SELECT id FROM subscriptions WHERE workspace_id=? AND status='active'").bind(WS).all<{ id: number }>()).results;
    for (const s of active) await ensurePeriodPayment(env.DB, s.id, P);

    const rows = (await env.DB.prepare("SELECT subscription_id sid, status, amount FROM payments WHERE workspace_id=? AND period=?")
      .bind(WS, P).all<{ sid: number; status: string; amount: number }>()).results;
    expect(rows).toHaveLength(4); // 4 active subs, exactly one bill each; the cancelled sub is not re-billed
    const bySub = new Map(rows.map((x) => [x.sid, x]));
    expect(bySub.get(S_PEND)).toMatchObject({ status: "pending", amount: 320 }); // freshly re-opened
    expect(bySub.get(S_REJ)).toMatchObject({ status: "pending", amount: 320 });
    expect(bySub.get(S_PAID)).toMatchObject({ status: "paid", amount: 315 });    // untouched, not duplicated
    expect(bySub.get(S_VER)).toMatchObject({ status: "verified", amount: 315 });
  });
});
