import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { routeInteraction, type DiscordInteraction } from "../../src/adapters/discord/handler";
import { findValidUploadToken, hashToken } from "../../src/core/tokens";
import { nowUtcIso, taipeiPeriod } from "../../src/core/time";

const TS = "2026-05-01T00:00:00.000Z";
const WS = 9009;
const GUILD = "guild-9009";
const DISC = "disc-9009";
const PERIOD = taipeiPeriod();

const tasks: Promise<unknown>[] = [];
const CTX = { waitUntil: (p: Promise<unknown>) => tasks.push(p) } as unknown as ExecutionContext;

beforeAll(async () => {
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO workspaces (id,name,owner_id,channel_type,billing_day,settings,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`)
      .bind(WS, "W", "o", "discord", 5, JSON.stringify({ discord_guild_id: GUILD }), TS, TS),
    env.DB.prepare(`INSERT INTO users (id,workspace_id,discord_id,display_name,created_at,updated_at) VALUES (?,?,?,?,?,?)`)
      .bind(WS, WS, DISC, "Member", TS, TS),
    env.DB.prepare(`INSERT INTO plans (id,workspace_id,name,provider,monthly_amount,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`)
      .bind(WS, WS, "ChatGPT", "openai", 315, TS, TS),
    env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`)
      .bind(WS, WS, WS, WS, "2026-05-01", 5, TS, TS),
  ]);
});

const member = (id: string) => ({ member: { user: { id } } });

describe("Discord interaction routing", () => {
  it("autocomplete returns the member's active subscriptions as choices", async () => {
    const i: DiscordInteraction = {
      type: 4, id: "1", token: "t", guild_id: GUILD, ...member(DISC),
      data: { name: "繳費", options: [{ name: "方案", focused: true, value: "" }] },
    };
    const res = await routeInteraction(i, env, CTX);
    const body = (await res.json()) as any;
    expect(body.type).toBe(8);
    expect(body.data.choices[0].value).toBe(String(WS));
  });

  it("/繳費 without screenshot defers, then marks the period paid (no proof)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
    const i: DiscordInteraction = {
      type: 2, id: "1", token: "tok", guild_id: GUILD, ...member(DISC),
      data: { name: "繳費", options: [{ name: "備註", value: "已轉帳" }] },
    };
    const res = await routeInteraction(i, env, CTX);
    expect((await res.json() as any).type).toBe(5); // deferred ephemeral
    await Promise.all(tasks.splice(0));
    vi.unstubAllGlobals();

    const p = await env.DB.prepare("SELECT status, has_proof, payment_note, source FROM payments WHERE subscription_id = ? AND period = ?")
      .bind(WS, PERIOD).first<{ status: string; has_proof: number; payment_note: string; source: string }>();
    expect(p?.status).toBe("paid");
    expect(p?.has_proof).toBe(0);
    expect(p?.payment_note).toBe("已轉帳");
    expect(p?.source).toBe("user_slash");
  });

  it("/繳費 with neither screenshot nor note is rejected (not registered)", async () => {
    const captured: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_u: unknown, init: RequestInit | undefined) => {
      if (typeof init?.body === "string") captured.push(JSON.parse(init.body).content);
      return new Response("{}", { status: 200 });
    }));
    const i: DiscordInteraction = {
      type: 2, id: "1", token: "tok2", guild_id: GUILD, ...member(DISC),
      data: { name: "繳費", options: [] },
    };
    const res = await routeInteraction(i, env, CTX);
    expect((await res.json() as any).type).toBe(5);
    await Promise.all(tasks.splice(0));
    vi.unstubAllGlobals();
    expect(captured.some((c) => c.includes("至少"))).toBe(true);
  });

  it("button issues a one-time upload link for the member", async () => {
    const i: DiscordInteraction = {
      type: 3, id: "1", token: "t", guild_id: GUILD, ...member(DISC),
      data: { custom_id: "chippot:pay" },
    };
    const res = await routeInteraction(i, env, CTX);
    const body = (await res.json()) as any;
    expect(body.type).toBe(4);
    expect(body.data.content).toContain("/u/");
    const raw = body.data.content.split("/u/")[1].trim();
    const tok = await findValidUploadToken(env.DB, await hashToken(raw), nowUtcIso());
    expect(tok?.user_id).toBe(WS);
    expect(tok?.subscription_id).toBe(WS); // single sub -> bound
  });

  it("rejects a non-member", async () => {
    const i: DiscordInteraction = {
      type: 3, id: "1", token: "t", guild_id: GUILD, ...member("stranger-999"),
      data: { custom_id: "chippot:pay" },
    };
    const res = await routeInteraction(i, env, CTX);
    expect((await res.json() as any).data.content).toContain("成員");
  });
});
