import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { routeInteraction, type DiscordInteraction } from "../../src/adapters/discord/handler";

// Fresh id band for this file: workspace/plan 9840, users 98401-98402, subs 98410-98411.
const TS = "2026-05-01T00:00:00.000Z";
const WS = 9840;
const GUILD = "guild-9840";
const DISC = "disc-9840", DISC_UNKNOWN = "disc-9849";
const USER = 98401, SUB_A = 98410, SUB_B = 98411;
const OPEN = "2029-08";   // opened + owed
const OLD = "2029-07";    // already verified — history only
const CTX = { waitUntil: () => {} } as unknown as ExecutionContext;

const cmd = (discordId: string): DiscordInteraction => ({
  type: 2, id: "i", token: "t", guild_id: GUILD,
  member: { user: { id: discordId } },
  data: { name: "我的帳單" },
});
const content = async (res: Response) => ((await res.json()) as any).data.content as string;

beforeAll(async () => {
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO workspaces (id,name,owner_id,channel_type,billing_day,settings,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(WS, "W", "o", "discord", 5, JSON.stringify({ discord_guild_id: GUILD }), TS, TS),
    env.DB.prepare(`INSERT INTO users (id,workspace_id,discord_id,display_name,created_at,updated_at) VALUES (?,?,?,?,?,?)`).bind(USER, WS, DISC, "王小明", TS, TS),
    env.DB.prepare(`INSERT INTO plans (id,workspace_id,name,provider,monthly_amount,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`).bind(WS, WS, "ChatGPT", "openai", 315, TS, TS),
    env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`).bind(SUB_A, WS, USER, WS, "2029-07-01", 5, "active", TS, TS),
    env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`).bind(SUB_B, WS, USER, WS, "2029-07-01", 5, "active", TS, TS),
    env.DB.prepare(`INSERT INTO payments (workspace_id,subscription_id,period,period_start,period_end,due_date,amount,status,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).bind(WS, SUB_A, OPEN, `${OPEN}-01`, `${OPEN}-31`, `${OPEN}-05`, 315, "pending", "cron", TS, TS),
    env.DB.prepare(`INSERT INTO payments (workspace_id,subscription_id,period,period_start,period_end,due_date,amount,status,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).bind(WS, SUB_B, OPEN, `${OPEN}-01`, `${OPEN}-31`, `${OPEN}-05`, 251, "rejected", "user_slash", TS, TS),
    env.DB.prepare(`INSERT INTO payments (workspace_id,subscription_id,period,period_start,period_end,due_date,amount,status,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).bind(WS, SUB_A, OLD, `${OLD}-01`, `${OLD}-31`, `${OLD}-05`, 315, "verified", "user_slash", TS, TS),
    env.DB.prepare(`INSERT INTO notification_logs (workspace_id,type,period,plan_id,user_id,subscription_id,event,sent_at) VALUES (?,?,?,?,?,?,?,?)`).bind(WS, "billing_opened", OPEN, 0, 0, 0, "", TS),
  ]);
});

describe("/我的帳單", () => {
  it("lists what the member still owes, per period, with a total", async () => {
    const text = await content((await routeInteraction(cmd(DISC), env, CTX)) as Response);
    expect(text).toContain(OPEN);
    expect(text).toContain("ChatGPT");
    expect(text).toContain("NT$566");
  });

  it("shows recent history with zh-TW statuses", async () => {
    const text = await content((await routeInteraction(cmd(DISC), env, CTX)) as Response);
    expect(text).toContain(OLD);
    expect(text).toContain("已驗證");
    expect(text).not.toContain("verified");
  });

  it("is ephemeral", async () => {
    const res = (await routeInteraction(cmd(DISC), env, CTX)) as Response;
    expect(((await res.json()) as any).data.flags).toBe(64);
  });

  it("tells an unbound Discord account how to bind instead of failing", async () => {
    const text = await content((await routeInteraction(cmd(DISC_UNKNOWN), env, CTX)) as Response);
    expect(text).toContain("綁定");
  });

  it("says so plainly when nothing is owed", async () => {
    await env.DB.prepare("UPDATE payments SET status = 'verified' WHERE workspace_id = ? AND period = ?").bind(WS, OPEN).run();
    const text = await content((await routeInteraction(cmd(DISC), env, CTX)) as Response);
    expect(text).toContain("目前沒有待繳項目");
  });
});
