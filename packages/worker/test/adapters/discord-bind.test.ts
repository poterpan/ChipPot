import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { routeInteraction, type DiscordInteraction } from "../../src/adapters/discord/handler";
import { taipeiPeriod } from "../../src/core/time";

const TS = "2026-05-01T00:00:00.000Z";
const WS = 9029;
const GUILD = "guild-9029";
const TAG = 9029;
const PLAN = 9029;
const U_UNBOUND = 90291; // unbound member to claim
const PERIOD = taipeiPeriod();

const tasks: Promise<unknown>[] = [];
const CTX = { waitUntil: (p: Promise<unknown>) => tasks.push(p) } as unknown as ExecutionContext;
const member = (id: string) => ({ member: { user: { id } } });

beforeAll(async () => {
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO workspaces (id,name,owner_id,channel_type,billing_day,settings,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(WS, "W", "o", "discord", 5, JSON.stringify({ discord_guild_id: GUILD }), TS, TS),
    env.DB.prepare(`INSERT INTO plans (id,workspace_id,name,provider,monthly_amount,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`).bind(PLAN, WS, "ChatGPT", "openai", 315, TS, TS),
    env.DB.prepare(`INSERT INTO users (id,workspace_id,display_name,created_at,updated_at) VALUES (?,?,?,?,?)`).bind(U_UNBOUND, WS, "小明", TS, TS),
    env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(WS, WS, U_UNBOUND, PLAN, "2026-05-01", 5, TS, TS),
    env.DB.prepare(`INSERT INTO channel_tags (id,workspace_id,name,type,sort_order,created_at) VALUES (?,?,?,?,?,?)`).bind(TAG, WS, "LINE Pay", "linepay", 1, TS),
    // Billing for this period is opened, so binding via the button can continue to the pay prompt.
    env.DB.prepare(`INSERT INTO notification_logs (workspace_id,type,period,plan_id,user_id,subscription_id,sent_at) VALUES (?,?,?,?,?,?,?)`).bind(WS, "billing_opened", PERIOD, 0, 0, 0, TS),
  ]);
});

describe("self-bind flow", () => {
  it("unbound member tapping 繳費 gets the bind select (origin=pay)", async () => {
    const i: DiscordInteraction = {
      type: 3, id: "1", token: "t", guild_id: GUILD, ...member("disc-new"),
      data: { custom_id: `chippot:pay:${WS}:v1`, component_type: 2 },
    };
    const res = await routeInteraction(i, env, CTX);
    const body = (await res.json()) as any;
    expect(body.type).toBe(4);
    const sel = body.data.components[0].components[0];
    expect(sel.custom_id).toBe(`chippot:bind:${WS}:pay`);
    expect(sel.options.map((o: any) => o.label)).toContain("小明");
  });

  it("bind via button (origin=pay) binds AND continues to the pay prompt (channel select)", async () => {
    const i: DiscordInteraction = {
      type: 3, id: "1", token: "t", guild_id: GUILD, ...member("disc-new"),
      data: { custom_id: `chippot:bind:${WS}:pay`, component_type: 3, values: [String(U_UNBOUND)] },
    };
    const res = await routeInteraction(i, env, CTX);
    const body = (await res.json()) as any;
    expect(body.type).toBe(7); // UPDATE_MESSAGE
    expect(body.data.content).toContain("已綁定為 小明");
    expect(body.data.components[0].components[0].custom_id).toBe(`chippot:paysel:${WS}:${PERIOD}`);
    const u = await env.DB.prepare("SELECT discord_id FROM users WHERE id=?").bind(U_UNBOUND).first<{ discord_id: string }>();
    expect(u?.discord_id).toBe("disc-new");
  });

  it("a second account claiming the same (now bound) name is rejected", async () => {
    const i: DiscordInteraction = {
      type: 3, id: "1", token: "t", guild_id: GUILD, ...member("disc-other"),
      data: { custom_id: `chippot:bind:${WS}:cmd`, component_type: 3, values: [String(U_UNBOUND)] },
    };
    const res = await routeInteraction(i, env, CTX);
    const body = (await res.json()) as any;
    expect(body.type).toBe(7);
    expect(body.data.content).toMatch(/綁定|失效/);
  });

  it("/綁定 from an already-bound caller tells them they're bound", async () => {
    const i: DiscordInteraction = {
      type: 2, id: "1", token: "t", guild_id: GUILD, ...member("disc-new"),
      data: { name: "綁定" },
    };
    const res = await routeInteraction(i, env, CTX);
    const body = (await res.json()) as any;
    expect(body.data.content).toContain("已綁定");
  });

  it("/繳費 from an unbound account returns a bind hint (not a settle)", async () => {
    const captured: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_u: unknown, init: RequestInit | undefined) => {
      if (typeof init?.body === "string") captured.push(JSON.parse(init.body).content);
      return new Response("{}", { status: 200 });
    }));
    const i: DiscordInteraction = {
      type: 2, id: "1", token: "tok", guild_id: GUILD, ...member("totally-unbound"),
      data: { name: "繳費", options: [{ name: "備註", value: "hi" }] },
    };
    await routeInteraction(i, env, CTX);
    await Promise.all(tasks.splice(0));
    vi.unstubAllGlobals();
    expect(captured.some((c) => c.includes("綁定"))).toBe(true);
  });
});
