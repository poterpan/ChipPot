import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { routeInteraction, type DiscordInteraction } from "../../src/adapters/discord/handler";
import { nextBillingPeriod } from "../../src/core/time";

const TS = "2026-05-01T00:00:00.000Z";
const WS = 9025;
const GUILD = "guild-9025";
const ADMIN = "admin-9025";
const NONADMIN = "rando-9025";
const PLAN = 9025;
const SUB = 9025;
const CHAN = "chan-9025";
// The 發起繳費 modal opens the *next* billing period: the handler computes it with
// nextBillingPeriod(workspace.billing_day), which rolls to next month once today is past the
// billing day. Match that here (workspace billing_day = 5, seeded below) instead of assuming the
// current calendar month — that assumption only held on days 1–5 and broke after the 5th.
const PERIOD = nextBillingPeriod(5);

const tasks: Promise<unknown>[] = [];
const CTX = { waitUntil: (p: Promise<unknown>) => tasks.push(p) } as unknown as ExecutionContext;
const member = (id: string) => ({ member: { user: { id } } });

beforeAll(async () => {
  const settings = JSON.stringify({ discord_guild_id: GUILD, discord_billing_channel_id: CHAN, admin_discord_ids: [ADMIN] });
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO workspaces (id,name,owner_id,channel_type,billing_day,settings,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(WS, "W", "o", "discord", 5, settings, TS, TS),
    env.DB.prepare(`INSERT INTO users (id,workspace_id,discord_id,display_name,created_at,updated_at) VALUES (?,?,?,?,?,?)`).bind(WS, WS, ADMIN, "Admin", TS, TS),
    env.DB.prepare(`INSERT INTO plans (id,workspace_id,name,provider,monthly_amount,discord_role_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(PLAN, WS, "ChatGPT", "openai", 315, "role-x", TS, TS),
    env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(SUB, WS, WS, PLAN, "2026-05-01", 5, TS, TS),
  ]);
});

describe("/發起繳費", () => {
  it("opens a modal pre-filled with current prices for a whitelisted admin", async () => {
    const i: DiscordInteraction = {
      type: 2, id: "1", token: "t", guild_id: GUILD, ...member(ADMIN),
      data: { name: "發起繳費" },
    };
    const res = await routeInteraction(i, env, CTX);
    const body = (await res.json()) as any;
    expect(body.type).toBe(9); // MODAL
    expect(body.data.custom_id).toBe(`chippot:initiate:${WS}:${PERIOD}`);
    expect(body.data.components[0].components[0].value).toBe("315");
  });

  it("rejects a non-whitelisted member", async () => {
    const i: DiscordInteraction = {
      type: 2, id: "1", token: "t", guild_id: GUILD, ...member(NONADMIN),
      data: { name: "發起繳費" },
    };
    const res = await routeInteraction(i, env, CTX);
    const body = (await res.json()) as any;
    expect(body.type).toBe(4);
    expect(body.data.content).toContain("權限");
  });

  it("modal submit updates the price and posts the notice", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
    (env as any).DISCORD_BOT_TOKEN = "bot-token";
    const i: DiscordInteraction = {
      type: 5, id: "1", token: "tok", guild_id: GUILD, ...member(ADMIN),
      data: {
        custom_id: `chippot:initiate:${WS}:${PERIOD}`,
        components: [{ components: [{ custom_id: `amt:${PLAN}`, value: "500" }] }],
      },
    };
    const res = await routeInteraction(i, env, CTX);
    expect((await res.json() as any).type).toBe(5); // deferred ephemeral
    await Promise.all(tasks.splice(0));
    vi.unstubAllGlobals();

    const p = await env.DB.prepare("SELECT monthly_amount FROM plans WHERE id=?").bind(PLAN).first<{ monthly_amount: number }>();
    expect(p?.monthly_amount).toBe(500);
  });
});
