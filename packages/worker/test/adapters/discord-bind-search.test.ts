import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { routeInteraction, type DiscordInteraction } from "../../src/adapters/discord/handler";
import { BIND_BUTTON_PREFIX, BIND_SEARCH_MODAL_PREFIX } from "../../src/adapters/discord/commands";

const TS = "2026-05-01T00:00:00.000Z";
const WS = 9410, GUILD = "guild-9410";
const CTX = { waitUntil: () => {} } as unknown as ExecutionContext;

beforeAll(async () => {
  const stmts = [
    env.DB.prepare(`INSERT INTO workspaces (id,name,owner_id,channel_type,billing_day,settings,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`)
      .bind(WS, "W", "o", "discord", 1, JSON.stringify({ discord_guild_id: GUILD }), TS, TS),
  ];
  // 30 unbound members (> Discord's 25 select cap): 成員01..成員30
  for (let n = 1; n <= 30; n++) {
    stmts.push(env.DB.prepare(`INSERT INTO users (id,workspace_id,display_name,created_at,updated_at) VALUES (?,?,?,?,?)`)
      .bind(94100 + n, WS, `成員${String(n).padStart(2, "0")}`, TS, TS));
  }
  await env.DB.batch(stmts);
});

describe("bind search when unbound > 25", () => {
  it("/綁定 名字 autocomplete returns filtered unbound choices (≤25, value=user id)", async () => {
    const i: DiscordInteraction = {
      type: 4, id: "1", token: "t", guild_id: GUILD, member: { user: { id: "d1" } },
      data: { name: "綁定", options: [{ name: "名字", focused: true, value: "成員0" }] },
    };
    const body = await (await routeInteraction(i, env, CTX)).json() as any;
    expect(body.type).toBe(8);
    expect(body.data.choices.length).toBeGreaterThan(0);
    expect(body.data.choices.length).toBeLessThanOrEqual(25);
    expect(Number.isInteger(Number(body.data.choices[0].value))).toBe(true);
  });

  it("/綁定 名字:<userId> binds that member directly", async () => {
    const uid = 94101; // 成員01
    const i: DiscordInteraction = {
      type: 2, id: "1", token: "t", guild_id: GUILD, member: { user: { id: "d-pick" } },
      data: { name: "綁定", options: [{ name: "名字", value: String(uid) }] },
    };
    const body = await (await routeInteraction(i, env, CTX)).json() as any;
    expect(body.data.content).toContain("已綁定");
    const u = await env.DB.prepare("SELECT discord_id FROM users WHERE id=?").bind(uid).first<{ discord_id: string | null }>();
    expect(u?.discord_id).toBe("d-pick");
  });

  it("the bind button opens a search modal when unbound > 25", async () => {
    const i: DiscordInteraction = {
      type: 3, id: "1", token: "t", guild_id: GUILD, member: { user: { id: "d-new" } },
      data: { custom_id: `${BIND_BUTTON_PREFIX}:${WS}`, component_type: 2 },
    };
    const body = await (await routeInteraction(i, env, CTX)).json() as any;
    expect(body.type).toBe(9); // RT_MODAL
    expect(body.data.custom_id).toBe(`${BIND_SEARCH_MODAL_PREFIX}:${WS}:cmd`);
  });

  it("submitting the search modal returns a filtered name picker", async () => {
    const i: DiscordInteraction = {
      type: 5, id: "1", token: "t", guild_id: GUILD, member: { user: { id: "d-search" } },
      data: { custom_id: `${BIND_SEARCH_MODAL_PREFIX}:${WS}:cmd`, components: [{ components: [{ custom_id: "q", value: "成員0" }] }] },
    };
    const body = await (await routeInteraction(i, env, CTX)).json() as any;
    expect(body.type).toBe(4); // RT_MESSAGE with a select
    expect(JSON.stringify(body)).toContain("chippot:bind:"); // bindSelectRow
    expect(JSON.stringify(body)).toContain("成員0");
  });

  it("/綁定 with no 名字 and >25 unbound hints to use the search field", async () => {
    const i: DiscordInteraction = {
      type: 2, id: "1", token: "t", guild_id: GUILD, member: { user: { id: "d-hint" } },
      data: { name: "綁定" },
    };
    const body = await (await routeInteraction(i, env, CTX)).json() as any;
    expect(body.data.content).toContain("名字");
  });
});
