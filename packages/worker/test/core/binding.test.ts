import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { listUnboundUsers, bindDiscordId } from "../../src/core/db";

const TS = "2026-05-01T00:00:00.000Z";
const WS = 9027;

beforeAll(async () => {
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO workspaces (id,name,owner_id,channel_type,billing_day,settings,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(WS, "W", "o", "discord", 5, "{}", TS, TS),
    env.DB.prepare(`INSERT INTO users (id,workspace_id,display_name,discord_id,created_at,updated_at) VALUES (?,?,?,?,?,?)`).bind(WS, WS, "Bound", "d-9027", TS, TS),
    env.DB.prepare(`INSERT INTO users (id,workspace_id,display_name,created_at,updated_at) VALUES (?,?,?,?,?)`).bind(90271, WS, "Unbound A", TS, TS),
    env.DB.prepare(`INSERT INTO users (id,workspace_id,display_name,created_at,updated_at) VALUES (?,?,?,?,?)`).bind(90272, WS, "Unbound B", TS, TS),
  ]);
});

describe("listUnboundUsers", () => {
  it("returns only users with NULL discord_id, ordered by id", async () => {
    const u = await listUnboundUsers(env.DB, WS);
    expect(u.map((x) => x.display_name)).toEqual(["Unbound A", "Unbound B"]);
    expect(u[0]).toMatchObject({ id: 90271 });
  });
});

describe("bindDiscordId", () => {
  it("binds an unbound user and returns ok + name", async () => {
    const r = await bindDiscordId(env, WS, 90271, "newdisc-1");
    expect(r).toEqual({ status: "ok", boundName: "Unbound A" });
    const u = await env.DB.prepare("SELECT discord_id FROM users WHERE id=?").bind(90271).first<{ discord_id: string }>();
    expect(u?.discord_id).toBe("newdisc-1");
  });

  it("rejects when the Discord account is already bound to someone else", async () => {
    const r = await bindDiscordId(env, WS, 90272, "newdisc-1");
    expect(r).toEqual({ status: "already_bound_other", boundName: "Unbound A" });
  });

  it("rejects binding a name that was already taken (target already bound)", async () => {
    const r = await bindDiscordId(env, WS, 90271, "fresh-disc");
    expect(r.status).toBe("name_taken");
  });

  it("returns not_found for a user outside the workspace", async () => {
    const r = await bindDiscordId(env, WS, 999999, "x-disc");
    expect(r.status).toBe("not_found");
  });
});
