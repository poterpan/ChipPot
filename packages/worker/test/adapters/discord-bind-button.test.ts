import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { routeInteraction, type DiscordInteraction } from "../../src/adapters/discord/handler";
import { BIND_BUTTON_PREFIX, bindButtonRow } from "../../src/adapters/discord/commands";

const TS = "2026-05-01T00:00:00.000Z";
const WS = 9400, GUILD = "guild-9400";
const CTX = { waitUntil: () => {} } as unknown as ExecutionContext;

beforeAll(async () => {
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO workspaces (id,name,owner_id,channel_type,billing_day,settings,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`)
      .bind(WS,"W","o","discord",5,JSON.stringify({ discord_guild_id: GUILD }),TS,TS),
    // one unbound member so the picker has an option
    env.DB.prepare(`INSERT INTO users (id,workspace_id,display_name,created_at,updated_at) VALUES (?,?,?,?,?)`).bind(WS,WS,"阿明",TS,TS),
  ]);
});

describe("persistent bind button", () => {
  it("bindButtonRow uses the bindbtn prefix (must not collide with bind-select)", () => {
    const row = bindButtonRow(WS) as any;
    expect(row.components[0].custom_id).toBe(`${BIND_BUTTON_PREFIX}:${WS}`);
    expect(BIND_BUTTON_PREFIX).toBe("chippot:bindbtn");
  });
  it("clicking the bind button returns an ephemeral name picker for an unbound member", async () => {
    const i: DiscordInteraction = {
      type: 3, id: "1", token: "t", guild_id: GUILD, member: { user: { id: "disc-new" } },
      data: { custom_id: `${BIND_BUTTON_PREFIX}:${WS}`, component_type: 2 },
    };
    const res = await routeInteraction(i, env, CTX);
    const body = await res.json() as any;
    expect(body.type).toBe(4); // RT_MESSAGE
    expect(JSON.stringify(body)).toContain("chippot:bind:"); // the select row, not mis-routed
    expect(JSON.stringify(body)).toContain("阿明");
  });
  it("an already-bound user gets the 已綁定 notice", async () => {
    await env.DB.prepare(`INSERT INTO users (id,workspace_id,discord_id,display_name,created_at,updated_at) VALUES (?,?,?,?,?,?)`).bind(94001,WS,"disc-bound","小華",TS,TS).run();
    const i: DiscordInteraction = {
      type: 3, id: "1", token: "t", guild_id: GUILD, member: { user: { id: "disc-bound" } },
      data: { custom_id: `${BIND_BUTTON_PREFIX}:${WS}`, component_type: 2 },
    };
    const res = await routeInteraction(i, env, CTX);
    expect((await res.json() as any).data.content).toContain("已綁定");
  });
});
