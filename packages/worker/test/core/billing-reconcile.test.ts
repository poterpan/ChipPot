import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { reconcilePeriodBills } from "../../src/core/billing";

const TS = "2026-05-01T00:00:00.000Z";
const WS = 9300, P = "2027-07";
const U_ADD = 9301, U_STALE = 9302, U_PRICE = 9303, U_PAID = 9304;
const S_ADD = 9301, S_STALE = 9302, S_PRICE = 9303, S_PAID = 9304;
const PLAN = 9300;

beforeAll(async () => {
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO workspaces (id,name,owner_id,channel_type,billing_day,settings,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(WS,"W","o","discord",5,"{}",TS,TS),
    env.DB.prepare(`INSERT INTO plans (id,workspace_id,name,provider,monthly_amount,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`).bind(PLAN,WS,"GPT","openai",320,TS,TS),
    env.DB.prepare(`INSERT INTO users (id,workspace_id,display_name,discord_id,created_at,updated_at) VALUES (?,?,?,?,?,?)`).bind(U_ADD,WS,"加入者",null,TS,TS),
    env.DB.prepare(`INSERT INTO users (id,workspace_id,display_name,discord_id,created_at,updated_at) VALUES (?,?,?,?,?,?)`).bind(U_STALE,WS,"退訂者",null,TS,TS),
    env.DB.prepare(`INSERT INTO users (id,workspace_id,display_name,discord_id,created_at,updated_at) VALUES (?,?,?,?,?,?)`).bind(U_PRICE,WS,"待改價",null,TS,TS),
    env.DB.prepare(`INSERT INTO users (id,workspace_id,display_name,discord_id,created_at,updated_at) VALUES (?,?,?,?,?,?)`).bind(U_PAID,WS,"已繳者","disc-paid",TS,TS),
    env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`).bind(S_ADD,WS,U_ADD,PLAN,"2027-01-01",5,"active",TS,TS),
    env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`).bind(S_STALE,WS,U_STALE,PLAN,"2027-01-01",5,"cancelled",TS,TS),
    env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`).bind(S_PRICE,WS,U_PRICE,PLAN,"2027-01-01",5,"active",TS,TS),
    env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`).bind(S_PAID,WS,U_PAID,PLAN,"2027-01-01",5,"active",TS,TS),
    env.DB.prepare(`INSERT INTO notification_logs (workspace_id,type,period,plan_id,user_id,subscription_id,sent_at) VALUES (?,?,?,?,?,?,?)`).bind(WS,"billing_opened",P,0,0,0,TS),
    env.DB.prepare(`INSERT INTO payments (workspace_id,subscription_id,period,period_start,period_end,due_date,amount,status,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).bind(WS,S_STALE,P,`${P}-01`,`${P}-31`,`${P}-05`,315,"pending","cron",TS,TS),
    env.DB.prepare(`INSERT INTO payments (workspace_id,subscription_id,period,period_start,period_end,due_date,amount,status,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).bind(WS,S_PRICE,P,`${P}-01`,`${P}-31`,`${P}-05`,315,"pending","cron",TS,TS),
    env.DB.prepare(`INSERT INTO payments (workspace_id,subscription_id,period,period_start,period_end,due_date,amount,status,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).bind(WS,S_PAID,P,`${P}-01`,`${P}-31`,`${P}-05`,315,"paid","cron",TS,TS),
  ]);
});

describe("reconcilePeriodBills", () => {
  it("dryRun computes add/remove/reprice/frozen without writing", async () => {
    const d = await reconcilePeriodBills(env, WS, P, { dryRun: true });
    expect(d.opened).toBe(true);
    expect(d.add.map((a) => a.subscription_id)).toEqual([S_ADD]);
    expect(d.add[0]!.amount).toBe(320);
    expect(d.remove.map((r) => r.subscription_id)).toEqual([S_STALE]);
    expect(d.reprice.map((r) => r.subscription_id)).toEqual([S_PRICE]);
    expect(d.reprice[0]!.from).toBe(315);
    expect(d.reprice[0]!.to).toBe(320);
    expect(d.frozen_count).toBe(1);
    const cnt = await env.DB.prepare("SELECT COUNT(*) c FROM payments WHERE workspace_id=? AND period=?").bind(WS, P).first<{ c: number }>();
    expect(cnt?.c).toBe(3); // nothing written
  });
  it("apply adds at current price, removes stale, reprices pending, freezes paid", async () => {
    await reconcilePeriodBills(env, WS, P, { dryRun: false });
    const rows = (await env.DB.prepare("SELECT subscription_id sid, amount, status FROM payments WHERE workspace_id=? AND period=?").bind(WS, P).all<{ sid: number; amount: number; status: string }>()).results;
    const bySub = new Map(rows.map((r) => [r.sid, r]));
    expect(bySub.has(S_STALE)).toBe(false);
    expect(bySub.get(S_ADD)?.amount).toBe(320);
    expect(bySub.get(S_PRICE)?.amount).toBe(320);
    expect(bySub.get(S_PAID)?.amount).toBe(315);
    expect(bySub.get(S_PAID)?.status).toBe("paid");
  });
  it("returns opened:false and no diff for a never-opened period", async () => {
    const d = await reconcilePeriodBills(env, WS, "2099-01", { dryRun: false });
    expect(d.opened).toBe(false);
    expect(d.add).toEqual([]);
    expect(d.remove).toEqual([]);
    expect(d.reprice).toEqual([]);
  });
});

// Edge matrix in an isolated workspace: status × sub-status combinations + R2 proof cleanup.
describe("reconcilePeriodBills edge matrix", () => {
  const W = 9310, PL = 9310, PE = "2027-08";
  const S_PAUSED = 93101, S_CANCEL_V = 93102, S_ACT_REJ = 93103, S_PROOF = 93104;
  beforeAll(async () => {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO workspaces (id,name,owner_id,channel_type,billing_day,settings,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(W,"W","o","discord",5,"{}",TS,TS),
      env.DB.prepare(`INSERT INTO plans (id,workspace_id,name,provider,monthly_amount,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`).bind(PL,W,"GPT","openai",320,TS,TS),
      env.DB.prepare(`INSERT INTO users (id,workspace_id,display_name,created_at,updated_at) VALUES (?,?,?,?,?)`).bind(W,W,"U",TS,TS),
      env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`).bind(S_PAUSED,W,W,PL,"2027-01-01",5,"paused",TS,TS),
      env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`).bind(S_CANCEL_V,W,W,PL,"2027-01-01",5,"cancelled",TS,TS),
      env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`).bind(S_ACT_REJ,W,W,PL,"2027-01-01",5,"active",TS,TS),
      env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`).bind(S_PROOF,W,W,PL,"2027-01-01",5,"cancelled",TS,TS),
      env.DB.prepare(`INSERT INTO notification_logs (workspace_id,type,period,plan_id,user_id,subscription_id,sent_at) VALUES (?,?,?,?,?,?,?)`).bind(W,"billing_opened",PE,0,0,0,TS),
      env.DB.prepare(`INSERT INTO payments (workspace_id,subscription_id,period,period_start,period_end,due_date,amount,status,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).bind(W,S_PAUSED,PE,`${PE}-01`,`${PE}-31`,`${PE}-05`,315,"pending","cron",TS,TS),
      env.DB.prepare(`INSERT INTO payments (workspace_id,subscription_id,period,period_start,period_end,due_date,amount,status,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).bind(W,S_CANCEL_V,PE,`${PE}-01`,`${PE}-31`,`${PE}-05`,315,"verified","cron",TS,TS),
      env.DB.prepare(`INSERT INTO payments (workspace_id,subscription_id,period,period_start,period_end,due_date,amount,status,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).bind(W,S_ACT_REJ,PE,`${PE}-01`,`${PE}-31`,`${PE}-05`,315,"rejected","cron",TS,TS),
      env.DB.prepare(`INSERT INTO payments (workspace_id,subscription_id,period,period_start,period_end,due_date,amount,status,source,screenshot_key,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).bind(W,S_PROOF,PE,`${PE}-01`,`${PE}-31`,`${PE}-05`,315,"pending","cron","proof-9310",TS,TS),
    ]);
    await env.BUCKET.put("proof-9310", "img");
  });

  it("categorizes paused→remove, cancelled-verified→frozen, active-rejected→untouched", async () => {
    const d = await reconcilePeriodBills(env, W, PE, { dryRun: true });
    expect(new Set(d.remove.map((r) => r.subscription_id))).toEqual(new Set([S_PAUSED, S_PROOF]));
    expect(d.reprice).toEqual([]);          // active sub's bill is rejected (not pending) → not repriced
    expect(d.add).toEqual([]);              // the only active sub already has a (rejected) bill
    expect(d.frozen_count).toBe(1);         // the cancelled-but-verified bill
  });

  it("apply removes stale pending/rejected of non-active subs, cleans the orphaned proof, keeps frozen", async () => {
    await reconcilePeriodBills(env, W, PE, { dryRun: false });
    const rows = (await env.DB.prepare("SELECT subscription_id sid, status, amount FROM payments WHERE workspace_id=? AND period=?").bind(W, PE).all<{ sid: number; status: string; amount: number }>()).results;
    const bySub = new Map(rows.map((r) => [r.sid, r]));
    expect(bySub.has(S_PAUSED)).toBe(false);            // paused pending → removed
    expect(bySub.has(S_PROOF)).toBe(false);             // cancelled pending → removed
    expect(bySub.get(S_CANCEL_V)?.status).toBe("verified"); // frozen (real settled record kept)
    expect(bySub.get(S_ACT_REJ)?.status).toBe("rejected");  // active+rejected untouched
    expect(bySub.get(S_ACT_REJ)?.amount).toBe(315);         // not repriced
    expect(await env.BUCKET.get("proof-9310")).toBeNull();  // orphaned proof cleaned
  });
});
