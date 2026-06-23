import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { routeInteraction, type DiscordInteraction } from "../../src/adapters/discord/handler";
import { taipeiPeriod, nextBillingPeriod } from "../../src/core/time";

const TS = "2026-05-01T00:00:00.000Z";
const WS = 9009;
const GUILD = "guild-9009";
const DISC = "disc-9009";
const TAG = 90091;
const PERIOD = taipeiPeriod();
// Second workspace used for the "billing not opened" gate + 發起繳費 default-period tests.
const WS2 = 9010;
const GUILD2 = "guild-9010";
const DISC2 = "disc-9010";

const tasks: Promise<unknown>[] = [];
const CTX = { waitUntil: (p: Promise<unknown>) => tasks.push(p) } as unknown as ExecutionContext;

beforeAll(async () => {
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO workspaces (id,name,owner_id,channel_type,billing_day,settings,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`)
      .bind(WS, "W", "o", "discord", 1, JSON.stringify({ discord_guild_id: GUILD }), TS, TS),
    env.DB.prepare(`INSERT INTO users (id,workspace_id,discord_id,display_name,created_at,updated_at) VALUES (?,?,?,?,?,?)`)
      .bind(WS, WS, DISC, "Member", TS, TS),
    env.DB.prepare(`INSERT INTO plans (id,workspace_id,name,provider,monthly_amount,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`)
      .bind(WS, WS, "ChatGPT", "openai", 315, TS, TS),
    env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`)
      .bind(WS, WS, WS, WS, "2026-05-01", 5, TS, TS),
    env.DB.prepare(`INSERT INTO channel_tags (id,workspace_id,name,type,sort_order,created_at) VALUES (?,?,?,?,?,?)`)
      .bind(TAG, WS, "LINE Pay", "mobilepayment", 1, TS),
    // Billing for WS/PERIOD is opened, so members may self-pay (gate precondition).
    env.DB.prepare(`INSERT INTO notification_logs (workspace_id,type,period,plan_id,user_id,subscription_id,sent_at) VALUES (?,?,?,?,?,?,?)`)
      .bind(WS, "billing_opened", PERIOD, 0, 0, 0, TS),
    // WS2: billing NOT opened; DISC2 is both a member and an admin (for 發起繳費 test).
    env.DB.prepare(`INSERT INTO workspaces (id,name,owner_id,channel_type,billing_day,settings,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`)
      .bind(WS2, "W2", "o", "discord", 5, JSON.stringify({ discord_guild_id: GUILD2, admin_discord_ids: [DISC2] }), TS, TS),
    env.DB.prepare(`INSERT INTO users (id,workspace_id,discord_id,display_name,created_at,updated_at) VALUES (?,?,?,?,?,?)`)
      .bind(WS2, WS2, DISC2, "Member2", TS, TS),
    env.DB.prepare(`INSERT INTO plans (id,workspace_id,name,provider,monthly_amount,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`)
      .bind(WS2, WS2, "ChatGPT", "openai", 315, TS, TS),
    env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`)
      .bind(WS2, WS2, WS2, WS2, "2026-05-01", 5, TS, TS),
  ]);
});

const member = (id: string) => ({ member: { user: { id } } });

describe("Discord interaction routing", () => {
  it("autocomplete returns the workspace's active channel tags", async () => {
    const i: DiscordInteraction = {
      type: 4, id: "1", token: "t", guild_id: GUILD, ...member(DISC),
      data: { name: "繳費", options: [{ name: "渠道", focused: true, value: "" }] },
    };
    const res = await routeInteraction(i, env, CTX);
    const body = (await res.json()) as any;
    expect(body.type).toBe(8);
    expect(body.data.choices.some((c: any) => c.value === String(TAG))).toBe(true);
  });

  it("/繳費 with 渠道 settles every active sub for the period", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
    const i: DiscordInteraction = {
      type: 2, id: "1", token: "tok", guild_id: GUILD, ...member(DISC),
      data: { name: "繳費", options: [{ name: "渠道", value: String(TAG) }] },
    };
    const res = await routeInteraction(i, env, CTX);
    expect((await res.json() as any).type).toBe(5); // deferred ephemeral
    await Promise.all(tasks.splice(0));
    vi.unstubAllGlobals();

    const p = await env.DB.prepare("SELECT status, declared_channel_tag_id, source FROM payments WHERE subscription_id = ? AND period = ?")
      .bind(WS, PERIOD).first<{ status: string; declared_channel_tag_id: number; source: string }>();
    expect(p?.status).toBe("paid");
    expect(p?.declared_channel_tag_id).toBe(TAG);
    expect(p?.source).toBe("user_slash");
  });

  it("/繳費 with nothing (no 渠道/截圖/備註) is rejected", async () => {
    // A fresh, unpaid member so we actually reach the at-least-one rule (DISC's period is paid by an earlier test).
    const U3 = 90093, S3 = 90094, DISC3 = "disc3-9009";
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO users (id,workspace_id,discord_id,display_name,created_at,updated_at) VALUES (?,?,?,?,?,?)`).bind(U3, WS, DISC3, "Member3", TS, TS),
      env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(S3, WS, U3, WS, "2026-05-01", 5, TS, TS),
    ]);
    const captured: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_u: unknown, init: RequestInit | undefined) => {
      if (typeof init?.body === "string") captured.push(JSON.parse(init.body).content);
      return new Response("{}", { status: 200 });
    }));
    const i: DiscordInteraction = {
      type: 2, id: "1", token: "tok2", guild_id: GUILD, ...member(DISC3),
      data: { name: "繳費", options: [] },
    };
    await routeInteraction(i, env, CTX);
    await Promise.all(tasks.splice(0));
    vi.unstubAllGlobals();
    expect(captured.some((c) => c.includes("至少"))).toBe(true);
  });

  it("rejects a non-member on the button", async () => {
    const i: DiscordInteraction = {
      type: 3, id: "1", token: "t", guild_id: GUILD, ...member("stranger-999"),
      data: { custom_id: `chippot:pay:${WS}:v1`, component_type: 2 },
    };
    const res = await routeInteraction(i, env, CTX);
    expect((await res.json() as any).data.content).toContain("成員");
  });

  it("blocks the pay button before billing is opened, creating no bill", async () => {
    const i: DiscordInteraction = {
      type: 3, id: "1", token: "t", guild_id: GUILD2, ...member(DISC2),
      data: { custom_id: `chippot:pay:${WS2}:v1`, component_type: 2 },
    };
    const res = await routeInteraction(i, env, CTX);
    expect((await res.json() as any).data.content).toContain("尚未開放");
    const cnt = await env.DB.prepare("SELECT COUNT(*) AS c FROM payments WHERE workspace_id = ?")
      .bind(WS2).first<{ c: number }>();
    expect(cnt?.c).toBe(0);
  });

  it("blocks /繳費 before billing is opened", async () => {
    const captured: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_u: unknown, init: RequestInit | undefined) => {
      if (typeof init?.body === "string") captured.push(JSON.parse(init.body).content);
      return new Response("{}", { status: 200 });
    }));
    const i: DiscordInteraction = {
      type: 2, id: "1", token: "tokg2", guild_id: GUILD2, ...member(DISC2),
      data: { name: "繳費", options: [{ name: "備註", value: "test" }] },
    };
    await routeInteraction(i, env, CTX);
    await Promise.all(tasks.splice(0));
    vi.unstubAllGlobals();
    expect(captured.some((c) => c.includes("尚未開放"))).toBe(true);
    const cnt = await env.DB.prepare("SELECT COUNT(*) AS c FROM payments WHERE workspace_id = ?")
      .bind(WS2).first<{ c: number }>();
    expect(cnt?.c).toBe(0);
  });

  it("/發起繳費 defaults the period to the next billing period", async () => {
    const i: DiscordInteraction = {
      type: 2, id: "1", token: "t", guild_id: GUILD2, ...member(DISC2),
      data: { name: "發起繳費" },
    };
    const res = await routeInteraction(i, env, CTX);
    const expected = nextBillingPeriod(5); // WS2 billing_day = 5
    expect(JSON.stringify(await res.json())).toContain(`initiate:${WS2}:${expected}`);
  });
});
