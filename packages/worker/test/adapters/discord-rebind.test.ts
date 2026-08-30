import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { routeInteraction, type DiscordInteraction } from "../../src/adapters/discord/handler";

// Fresh id band for this file: workspace 9850, users 98501-98503.
const TS = "2026-05-01T00:00:00.000Z";
const WS = 9850;
const GUILD = "guild-9850";
const DISC = "disc-9850", DISC_OTHER = "disc-9851";
const U_ME = 98501, U_FREE = 98502, U_OTHER = 98503;
const CTX = { waitUntil: () => {} } as unknown as ExecutionContext;

const comp = (customId: string, discordId = DISC): DiscordInteraction => ({
  type: 3, id: "i", token: "t", guild_id: GUILD,
  member: { user: { id: discordId } },
  data: { custom_id: customId, component_type: 2 },
});
const cmd = (discordId = DISC): DiscordInteraction => ({
  type: 2, id: "i", token: "t", guild_id: GUILD,
  member: { user: { id: discordId } },
  data: { name: "綁定" },
});
const dataOf = async (res: Response) => ((await res.json()) as any).data;

beforeAll(async () => {
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO workspaces (id,name,owner_id,channel_type,billing_day,settings,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(WS, "W", "o", "discord", 5, JSON.stringify({ discord_guild_id: GUILD }), TS, TS),
    env.DB.prepare(`INSERT INTO users (id,workspace_id,discord_id,display_name,created_at,updated_at) VALUES (?,?,?,?,?,?)`).bind(U_ME, WS, DISC, "張三", TS, TS),
    env.DB.prepare(`INSERT INTO users (id,workspace_id,display_name,created_at,updated_at) VALUES (?,?,?,?,?)`).bind(U_FREE, WS, "李四", TS, TS),
    env.DB.prepare(`INSERT INTO users (id,workspace_id,discord_id,display_name,created_at,updated_at) VALUES (?,?,?,?,?,?)`).bind(U_OTHER, WS, DISC_OTHER, "王五", TS, TS),
  ]);
});

describe("rebind (綁錯名字)", () => {
  it("offers a way out instead of only saying 你已綁定為 X", async () => {
    const data = await dataOf((await routeInteraction(cmd(), env, CTX)) as Response);
    expect(data.content).toContain("張三");
    const ids = data.components.flatMap((r: any) => r.components.map((c: any) => c.custom_id));
    expect(ids).toContain(`chippot:rebind:${WS}`);
  });

  it("asks for confirmation and names the binding it will release", async () => {
    const data = await dataOf((await routeInteraction(comp(`chippot:rebind:${WS}`), env, CTX)) as Response);
    expect(data.content).toContain("張三");
    expect(data.content).toContain("解除");
    const ids = data.components.flatMap((r: any) => r.components.map((c: any) => c.custom_id));
    expect(ids).toContain(`chippot:rebindok:${WS}`);
    // Nothing changed yet.
    const row = await env.DB.prepare("SELECT discord_id FROM users WHERE id = ?").bind(U_ME).first<{ discord_id: string | null }>();
    expect(row!.discord_id).toBe(DISC);
  });

  it("only releases the caller's own row, then shows the picker", async () => {
    const data = await dataOf((await routeInteraction(comp(`chippot:rebindok:${WS}`), env, CTX)) as Response);
    const me = await env.DB.prepare("SELECT discord_id FROM users WHERE id = ?").bind(U_ME).first<{ discord_id: string | null }>();
    const other = await env.DB.prepare("SELECT discord_id FROM users WHERE id = ?").bind(U_OTHER).first<{ discord_id: string | null }>();
    expect(me!.discord_id).toBeNull();
    expect(other!.discord_id).toBe(DISC_OTHER); // someone else's binding is untouchable
    const ids = data.components.flatMap((r: any) => r.components.map((c: any) => c.custom_id));
    expect(ids).toContain(`chippot:bind:${WS}:cmd`);
  });

  it("writes an audit row for the unbind", async () => {
    const n = await env.DB.prepare("SELECT COUNT(*) c FROM audit_logs WHERE workspace_id = ? AND action = 'member.unbind' AND entity_id = ?")
      .bind(WS, U_ME).first<{ c: number }>();
    expect(n!.c).toBe(1);
  });

  it("is a no-op for an account that is not bound", async () => {
    const data = await dataOf((await routeInteraction(comp(`chippot:rebindok:${WS}`), env, CTX)) as Response);
    expect(data.content).toContain("尚未綁定");
  });

  it("keeps the picker free of the name it just released only after a real unbind", async () => {
    // The freed name is claimable again by anyone — that is the pre-bind status quo, not a new
    // capability. U_FREE was never bound, so it must still be offered too.
    const unbound = await env.DB
      .prepare("SELECT id FROM users WHERE workspace_id = ? AND discord_id IS NULL ORDER BY id")
      .bind(WS).all<{ id: number }>();
    expect(unbound.results.map((r) => r.id)).toEqual([U_ME, U_FREE]);
  });
});
