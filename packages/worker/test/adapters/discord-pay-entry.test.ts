import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { routeInteraction, type DiscordInteraction } from "../../src/adapters/discord/handler";
import { payCommand } from "../../src/adapters/discord/commands";

// Fresh id band for this file: workspace/plan 9830, user 98301, sub 98310, channel tag 98308.
const TS = "2026-05-01T00:00:00.000Z";
const WS = 9830;
const GUILD = "guild-9830";
const DISC = "disc-9830";
const USER = 98301, SUB = 98310, TAG = 98308;
const PERIOD = "2029-06";
const CTX = { waitUntil: () => {} } as unknown as ExecutionContext;

beforeAll(async () => {
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO workspaces (id,name,owner_id,channel_type,billing_day,settings,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(WS, "W", "o", "discord", 5, JSON.stringify({ discord_guild_id: GUILD }), TS, TS),
    env.DB.prepare(`INSERT INTO users (id,workspace_id,discord_id,display_name,created_at,updated_at) VALUES (?,?,?,?,?,?)`).bind(USER, WS, DISC, "王小明", TS, TS),
    env.DB.prepare(`INSERT INTO plans (id,workspace_id,name,provider,monthly_amount,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`).bind(WS, WS, "ChatGPT", "openai", 315, TS, TS),
    env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`).bind(SUB, WS, USER, WS, "2029-06-01", 5, "active", TS, TS),
    env.DB.prepare(`INSERT INTO payments (workspace_id,subscription_id,period,period_start,period_end,due_date,amount,status,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).bind(WS, SUB, PERIOD, `${PERIOD}-01`, `${PERIOD}-30`, `${PERIOD}-05`, 315, "pending", "cron", TS, TS),
    env.DB.prepare(`INSERT INTO notification_logs (workspace_id,type,period,plan_id,user_id,subscription_id,event,sent_at) VALUES (?,?,?,?,?,?,?,?)`).bind(WS, "billing_opened", PERIOD, 0, 0, 0, "", TS),
    env.DB.prepare(`INSERT INTO channel_tags (id,workspace_id,name,type,sort_order,created_at) VALUES (?,?,?,?,?,?)`).bind(TAG, WS, "LINE Pay", "mobilepayment", 1, TS),
  ]);
});

const payButton = (): DiscordInteraction => ({
  type: 3, id: "i", token: "t", guild_id: GUILD,
  member: { user: { id: DISC } },
  data: { custom_id: `chippot:pay:${WS}:v1`, component_type: 2 },
});
const content = async (res: Response) => ((await res.json()) as any).data.content as string;

describe("payCommand registration payload", () => {
  it("offers 截圖 and says at least one field is required when R2 is on", () => {
    const c = payCommand(true);
    expect(c.options.map((o: any) => o.name)).toEqual(["渠道", "截圖", "備註"]);
    expect(c.description).toContain("至少填一項");
    expect(c.description).not.toContain("可選");
  });

  it("drops the 截圖 option entirely when R2 is off", () => {
    const c = payCommand(false);
    expect(c.options.map((o: any) => o.name)).toEqual(["渠道", "備註"]);
    expect(c.description).not.toContain("截圖");
  });
});

describe("pay prompt discloses each entry point's limits up front", () => {
  it("tells the member the button only picks a channel, and where to attach a screenshot", async () => {
    const text = await content(await routeInteraction(payButton(), env, CTX) as Response);
    expect(text).toContain("只能選渠道");
    expect(text).toContain("截圖");
    expect(text).toContain("/繳費");
  });

  it("does not promise screenshots when R2 is off", async () => {
    const prev = (env as any).BUCKET;
    (env as any).BUCKET = undefined;
    const text = await content(await routeInteraction(payButton(), env, CTX) as Response);
    (env as any).BUCKET = prev;
    expect(text).toContain("未開啟截圖");
    expect(text).not.toMatch(/想附截圖/);
  });

  it("does not send a member down the screenshot path when there is no channel tag either", async () => {
    const prevBucket = (env as any).BUCKET;
    (env as any).BUCKET = undefined;
    await env.DB.prepare("UPDATE channel_tags SET active = 0 WHERE id = ?").bind(TAG).run();
    const text = await content(await routeInteraction(payButton(), env, CTX) as Response);
    await env.DB.prepare("UPDATE channel_tags SET active = 1 WHERE id = ?").bind(TAG).run();
    (env as any).BUCKET = prevBucket;
    expect(text).toContain("備註");
    expect(text).not.toContain("可附截圖");
  });
});
