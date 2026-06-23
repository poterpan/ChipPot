import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import {
  getWorkspace, getActivePlans, listActiveChannelTags, listSettleablePayments, listOpenPayablePeriods,
  searchUnboundUsers,
} from "../../src/core/db";

const TS = "2026-05-01T00:00:00.000Z";
const WS = 9020;
const SUB_A = 9020, SUB_B = 90201;
const PLAN_B = 90201;

beforeAll(async () => {
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO workspaces (id,name,owner_id,channel_type,billing_day,settings,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(WS, "W", "o", "discord", 5, "{}", TS, TS),
    env.DB.prepare(`INSERT INTO users (id,workspace_id,display_name,created_at,updated_at) VALUES (?,?,?,?,?)`).bind(WS, WS, "U", TS, TS),
    env.DB.prepare(`INSERT INTO plans (id,workspace_id,name,provider,monthly_amount,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`).bind(WS, WS, "ChatGPT", "openai", 315, TS, TS),
    env.DB.prepare(`INSERT INTO plans (id,workspace_id,name,provider,monthly_amount,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`).bind(PLAN_B, WS, "Claude", "anthropic", 251, TS, TS),
    env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(SUB_A, WS, WS, WS, "2027-01-01", 5, TS, TS),
    env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(SUB_B, WS, WS, PLAN_B, "2027-01-01", 5, TS, TS),
    env.DB.prepare(`INSERT INTO channel_tags (id,workspace_id,name,type,active,sort_order,created_at) VALUES (?,?,?,?,?,?,?)`).bind(WS, WS, "LINE Pay", "mobilepayment", 1, 1, TS),
    env.DB.prepare(`INSERT INTO channel_tags (id,workspace_id,name,type,active,sort_order,created_at) VALUES (?,?,?,?,?,?,?)`).bind(90201, WS, "停用", "other", 0, 2, TS),
    env.DB.prepare(`INSERT INTO payments (workspace_id,subscription_id,period,period_start,period_end,due_date,amount,status,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).bind(WS, SUB_A, "2027-01", "2027-01-01", "2027-01-31", "2027-01-05", 315, "pending", "cron", TS, TS),
    env.DB.prepare(`INSERT INTO payments (workspace_id,subscription_id,period,period_start,period_end,due_date,amount,status,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).bind(WS, SUB_B, "2027-01", "2027-01-01", "2027-01-31", "2027-01-05", 251, "pending", "cron", TS, TS),
  ]);
});

describe("db getters", () => {
  it("getWorkspace returns the seeded workspace", async () => {
    const ws = await getWorkspace(env.DB, 1);
    expect(ws?.name).toBe("社團 AI 訂閱");
    expect(ws?.channel_type).toBe("discord");
  });

  it("getWorkspace returns null for unknown id", async () => {
    expect(await getWorkspace(env.DB, 9999)).toBeNull();
  });

  it("getActivePlans returns the three seeded plans", async () => {
    const plans = await getActivePlans(env.DB, 1);
    expect(plans.map((p) => p.name)).toEqual([
      "ChatGPT", "Claude Standard", "Claude Premium",
    ]);
  });
});

describe("channel tags + settleable payments", () => {
  it("listActiveChannelTags returns only active tags, sorted", async () => {
    const tags = await listActiveChannelTags(env.DB, WS);
    expect(tags.map((t) => t.name)).toEqual(["LINE Pay"]);
  });

  it("listSettleablePayments returns pending/rejected payments for the user's active subs", async () => {
    const rows = await listSettleablePayments(env.DB, WS, WS, "2027-01");
    expect(rows.length).toBe(2);
    expect(rows.reduce((s, r) => s + r.amount, 0)).toBe(566);
    expect(rows[0]).toHaveProperty("plan_name");
  });
});

describe("listOpenPayablePeriods", () => {
  const W = 9030, U = 9030, P = 9030, S = 9030;
  const pmt = (period: string, status: string) =>
    env.DB.prepare(`INSERT INTO payments (workspace_id,subscription_id,period,period_start,period_end,due_date,amount,status,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(W, S, period, `${period}-01`, `${period}-28`, `${period}-05`, 315, status, "cron", TS, TS);
  const opened = (period: string) =>
    env.DB.prepare(`INSERT INTO notification_logs (workspace_id,type,period,plan_id,user_id,subscription_id,sent_at) VALUES (?,?,?,?,?,?,?)`)
      .bind(W, "billing_opened", period, 0, 0, 0, TS);
  beforeAll(async () => {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO workspaces (id,name,owner_id,channel_type,billing_day,settings,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(W, "W", "o", "discord", 1, "{}", TS, TS),
      env.DB.prepare(`INSERT INTO users (id,workspace_id,display_name,created_at,updated_at) VALUES (?,?,?,?,?)`).bind(U, W, "U", TS, TS),
      env.DB.prepare(`INSERT INTO plans (id,workspace_id,name,provider,monthly_amount,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`).bind(P, W, "ChatGPT", "openai", 315, TS, TS),
      env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(S, W, U, P, "2027-01-01", 1, TS, TS),
      pmt("2027-06", "pending"), opened("2027-06"),  // opened + owed → payable
      pmt("2027-07", "pending"), opened("2027-07"),  // opened + owed (newer) → payable
      pmt("2027-05", "pending"),                      // owed but NOT opened → excluded
      pmt("2027-04", "paid"), opened("2027-04"),      // opened but paid → excluded
    ]);
  });
  it("returns only opened-and-owed periods, oldest first", async () => {
    expect(await listOpenPayablePeriods(env.DB, W, U)).toEqual(["2027-06", "2027-07"]);
  });
});

describe("searchUnboundUsers", () => {
  const W = 9040;
  beforeAll(async () => {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO workspaces (id,name,owner_id,channel_type,billing_day,settings,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(W,"W","o","discord",1,"{}",TS,TS),
      env.DB.prepare(`INSERT INTO users (id,workspace_id,display_name,discord_id,created_at,updated_at) VALUES (?,?,?,?,?,?)`).bind(90401,W,"阿明",null,TS,TS),
      env.DB.prepare(`INSERT INTO users (id,workspace_id,display_name,discord_id,created_at,updated_at) VALUES (?,?,?,?,?,?)`).bind(90402,W,"阿華",null,TS,TS),
      env.DB.prepare(`INSERT INTO users (id,workspace_id,display_name,discord_id,created_at,updated_at) VALUES (?,?,?,?,?,?)`).bind(90403,W,"小傑",null,TS,TS),
      env.DB.prepare(`INSERT INTO users (id,workspace_id,display_name,discord_id,created_at,updated_at) VALUES (?,?,?,?,?,?)`).bind(90404,W,"阿傑","disc-bound",TS,TS), // bound — excluded
    ]);
  });
  it("returns unbound users matching the substring", async () => {
    const r = await searchUnboundUsers(env.DB, W, "阿", 25);
    expect(r.map((u) => u.display_name)).toEqual(["阿明", "阿華"]); // 阿傑 is bound → excluded
  });
  it("excludes bound users and respects the limit", async () => {
    const r = await searchUnboundUsers(env.DB, W, "", 2); // empty query = all unbound, capped
    expect(r.length).toBe(2);
    expect(r.every((u) => u.id !== 90404)).toBe(true);
  });
  it("treats LIKE wildcards in the query literally", async () => {
    expect(await searchUnboundUsers(env.DB, W, "%", 25)).toEqual([]); // no name contains a literal %
  });
});
