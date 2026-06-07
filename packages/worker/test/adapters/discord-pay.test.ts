import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { routeInteraction, type DiscordInteraction } from "../../src/adapters/discord/handler";
import { taipeiPeriod } from "../../src/core/time";

const TS = "2026-05-01T00:00:00.000Z";
const WS = 9024;
const GUILD = "guild-9024";
const DISC = "disc-9024";
const SUB_A = 9024, SUB_B = 90241;
const PLAN_B = 90241;
const TAG = 9024;
const PERIOD = taipeiPeriod();

const tasks: Promise<unknown>[] = [];
const CTX = { waitUntil: (p: Promise<unknown>) => tasks.push(p) } as unknown as ExecutionContext;
const member = (id: string) => ({ member: { user: { id } } });

beforeAll(async () => {
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO workspaces (id,name,owner_id,channel_type,billing_day,settings,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(WS, "W", "o", "discord", 1, JSON.stringify({ discord_guild_id: GUILD }), TS, TS),
    env.DB.prepare(`INSERT INTO users (id,workspace_id,discord_id,display_name,created_at,updated_at) VALUES (?,?,?,?,?,?)`).bind(WS, WS, DISC, "Member", TS, TS),
    env.DB.prepare(`INSERT INTO plans (id,workspace_id,name,provider,monthly_amount,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`).bind(WS, WS, "ChatGPT", "openai", 315, TS, TS),
    env.DB.prepare(`INSERT INTO plans (id,workspace_id,name,provider,monthly_amount,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`).bind(PLAN_B, WS, "Claude", "anthropic", 251, TS, TS),
    env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(SUB_A, WS, WS, WS, "2026-05-01", 5, TS, TS),
    env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(SUB_B, WS, WS, PLAN_B, "2026-05-01", 5, TS, TS),
    env.DB.prepare(`INSERT INTO channel_tags (id,workspace_id,name,type,sort_order,created_at) VALUES (?,?,?,?,?,?)`).bind(TAG, WS, "LINE Pay", "mobilepayment", 1, TS),
    // Billing for this period is opened, so members may self-pay (gate precondition).
    env.DB.prepare(`INSERT INTO notification_logs (workspace_id,type,period,plan_id,user_id,subscription_id,sent_at) VALUES (?,?,?,?,?,?,?)`).bind(WS, "billing_opened", PERIOD, 0, 0, 0, TS),
  ]);
});

describe("button → channel select → settle", () => {
  it("button shows the per-plan total + a channel select", async () => {
    const i: DiscordInteraction = {
      type: 3, id: "1", token: "t", guild_id: GUILD, ...member(DISC),
      data: { custom_id: `chippot:pay:${WS}:v1`, component_type: 2 },
    };
    const res = await routeInteraction(i, env, CTX);
    const body = (await res.json()) as any;
    expect(body.type).toBe(4); // ephemeral message
    expect(body.data.content).toContain("566"); // 315 + 251
    const select = body.data.components[0].components[0];
    expect(select.type).toBe(3);
    expect(select.custom_id).toBe(`chippot:paysel:${WS}:${PERIOD}`);
    expect(select.min_values).toBe(1);
  });

  it("select submit settles all subs and confirms", async () => {
    const i: DiscordInteraction = {
      type: 3, id: "1", token: "t", guild_id: GUILD, ...member(DISC),
      data: { custom_id: `chippot:paysel:${WS}:${PERIOD}`, component_type: 3, values: [String(TAG)] },
    };
    const res = await routeInteraction(i, env, CTX);
    const body = (await res.json()) as any;
    expect(body.type).toBe(7); // UPDATE_MESSAGE
    expect(body.data.content).toContain("566");

    const rows = await env.DB.prepare("SELECT status, declared_channel_tag_id FROM payments WHERE workspace_id=? AND period=?").bind(WS, PERIOD).all<{ status: string; declared_channel_tag_id: number }>();
    expect(rows.results.length).toBe(2);
    expect(rows.results.every((p) => p.status === "paid")).toBe(true);
    expect(rows.results.every((p) => p.declared_channel_tag_id === TAG)).toBe(true);
  });

  it("select submit with a foreign/invalid tag is rejected (type 7, no settle)", async () => {
    const i: DiscordInteraction = {
      type: 3, id: "1", token: "t", guild_id: GUILD, ...member(DISC),
      data: { custom_id: `chippot:paysel:${WS}:${PERIOD}`, component_type: 3, values: ["999999"] },
    };
    const res = await routeInteraction(i, env, CTX);
    const body = (await res.json()) as any;
    expect(body.type).toBe(7);
    expect(body.data.content).toContain("渠道無效");
  });

  it("select submit with a malformed period custom_id is rejected (type 7)", async () => {
    const i: DiscordInteraction = {
      type: 3, id: "1", token: "t", guild_id: GUILD, ...member(DISC),
      data: { custom_id: `chippot:paysel:${WS}:BADPERIOD`, component_type: 3, values: [String(TAG)] },
    };
    const res = await routeInteraction(i, env, CTX);
    const body = (await res.json()) as any;
    expect(body.type).toBe(7);
    expect(body.data.content).toContain("失效");
  });

  it("button after paying says already registered", async () => {
    const i: DiscordInteraction = {
      type: 3, id: "1", token: "t", guild_id: GUILD, ...member(DISC),
      data: { custom_id: `chippot:pay:${WS}:v1`, component_type: 2 },
    };
    const res = await routeInteraction(i, env, CTX);
    const body = (await res.json()) as any;
    expect(body.data.content).toContain("已登記繳費");
  });
});

describe("/繳費 with no R2 ignores the screenshot", () => {
  it("tells the member to use channel/note when only a screenshot is given and R2 is off", async () => {
    const prevB = (env as any).BUCKET;
    const prevApp = (env as any).DISCORD_APPLICATION_ID;
    (env as any).BUCKET = undefined;
    (env as any).DISCORD_APPLICATION_ID = "app-9024";
    let captured = "";
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: any) => { captured = JSON.parse(init.body).content; return new Response("{}", { status: 200 }); }));
    const i: DiscordInteraction = {
      type: 2, id: "1", token: "tok", guild_id: GUILD, ...member(DISC),
      data: { name: "繳費", options: [{ name: "截圖", value: "att1" }], resolved: { attachments: { att1: { url: "https://cdn.discordapp.com/x.png", content_type: "image/png", size: 100 } } } },
    } as any;
    const res = await routeInteraction(i, env, CTX);
    expect((await res.json() as any).type).toBe(5); // deferred
    await Promise.all(tasks.splice(0));
    vi.unstubAllGlobals();
    (env as any).BUCKET = prevB;
    (env as any).DISCORD_APPLICATION_ID = prevApp;
    expect(captured).toContain("未開啟截圖功能");
  });

  it("settles and notes the ignored screenshot on success (channel + screenshot, no R2)", async () => {
    const U2 = 90247, S2 = 90248, DISC2 = "disc2-9024";
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO users (id,workspace_id,discord_id,display_name,created_at,updated_at) VALUES (?,?,?,?,?,?)`).bind(U2, WS, DISC2, "Member2", TS, TS),
      env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(S2, WS, U2, WS, "2026-05-01", 5, TS, TS),
    ]);
    const prevB = (env as any).BUCKET;
    const prevApp = (env as any).DISCORD_APPLICATION_ID;
    (env as any).BUCKET = undefined;
    (env as any).DISCORD_APPLICATION_ID = "app-9024";
    let captured = "";
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: any) => { captured = JSON.parse(init.body).content; return new Response("{}", { status: 200 }); }));
    const i: DiscordInteraction = {
      type: 2, id: "1", token: "tok", guild_id: GUILD, ...member(DISC2),
      data: { name: "繳費", options: [{ name: "渠道", value: String(TAG) }, { name: "截圖", value: "att1" }], resolved: { attachments: { att1: { url: "https://cdn.discordapp.com/x.png", content_type: "image/png", size: 100 } } } },
    } as any;
    const res = await routeInteraction(i, env, CTX);
    expect((await res.json() as any).type).toBe(5);
    await Promise.all(tasks.splice(0));
    vi.unstubAllGlobals();
    (env as any).BUCKET = prevB;
    (env as any).DISCORD_APPLICATION_ID = prevApp;
    expect(captured).toContain("已登記本期");
    expect(captured).toContain("已記錄你的繳費宣告");
  });
});
