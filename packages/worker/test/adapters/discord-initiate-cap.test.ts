import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { routeInteraction, type DiscordInteraction } from "../../src/adapters/discord/handler";

const TS = "2026-05-01T00:00:00.000Z";
const WS = 9850;
const GUILD = "guild-9850";
const ADMIN = "admin-9850";
const USER = 9850;
const CTX = { waitUntil: () => {} } as unknown as ExecutionContext;
const member = (id: string) => ({ member: { user: { id } } });

beforeAll(async () => {
  const settings = JSON.stringify({ discord_guild_id: GUILD, discord_billing_channel_id: "chan-9850", admin_discord_ids: [ADMIN] });
  const stmts = [
    env.DB.prepare(`INSERT INTO workspaces (id,name,owner_id,channel_type,billing_day,settings,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(WS, "W", "o", "discord", 1, settings, TS, TS),
    env.DB.prepare(`INSERT INTO users (id,workspace_id,discord_id,display_name,created_at,updated_at) VALUES (?,?,?,?,?,?)`).bind(USER, WS, ADMIN, "Admin", TS, TS),
  ];
  // 6 個啟用中的方案 → 超過 Discord modal 的 5 欄上限
  for (let i = 0; i < 6; i++) {
    stmts.push(env.DB.prepare(`INSERT INTO plans (id,workspace_id,name,provider,monthly_amount,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`).bind(98500 + i, WS, `Plan${i}`, "openai", 100 + i, TS, TS));
    stmts.push(env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(98500 + i, WS, USER, 98500 + i, "2026-05-01", 1, TS, TS));
  }
  await env.DB.batch(stmts);
});

describe("/發起繳費 的方案數上限", () => {
  it("方案超過 5 個時明確拒絕並指向後台，而不是靜默丟掉第 6 個以後", async () => {
    const i: DiscordInteraction = { type: 2, id: "1", token: "t", guild_id: GUILD, ...member(ADMIN), data: { name: "發起繳費" } };
    const res = await routeInteraction(i, env, CTX);
    const body = (await res.json()) as any;
    expect(body.type).toBe(4); // ephemeral message, NOT a modal
    expect(body.data.content).toContain("6");
    expect(body.data.content).toContain("後台");
  });
});
