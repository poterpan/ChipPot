import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { handleImage } from "../../src/routes/images";
import { putObject } from "../../src/core/storage";
import type { RouteCtx } from "../../src/router";

const TS = "2026-05-01T00:00:00.000Z";
const WS = 9007;
const KEY = "9007/2026-06/9007/proof.png";
const bytes = new Uint8Array([9, 8, 7]);

const ctxFor = (key?: string): RouteCtx => ({
  params: {},
  url: new URL(`https://x/admin/image${key !== undefined ? `?key=${encodeURIComponent(key)}` : ""}`),
});

beforeAll(async () => {
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO workspaces (id,name,owner_id,channel_type,billing_day,settings,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(WS, "W", "o", "discord", 5, "{}", TS, TS),
    env.DB.prepare(`INSERT INTO users (id,workspace_id,display_name,created_at,updated_at) VALUES (?,?,?,?,?)`).bind(WS, WS, "U", TS, TS),
    env.DB.prepare(`INSERT INTO plans (id,workspace_id,name,provider,monthly_amount,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`).bind(WS, WS, "P", "openai", 315, TS, TS),
    env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(WS, WS, WS, WS, "2026-06-01", 5, TS, TS),
    env.DB.prepare(`INSERT INTO payments (workspace_id,subscription_id,period,period_start,period_end,due_date,amount,status,has_proof,screenshot_key,source,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(WS, WS, "2026-06", "2026-06-01", "2026-06-30", "2026-06-05", 315, "paid", 1, KEY, "user_web", TS, TS),
  ]);
  await putObject(env.BUCKET, KEY, bytes, "image/png");
});

describe("protected image endpoint", () => {
  it("streams a known proof with no-store", async () => {
    const res = await handleImage(new Request("https://x"), env, ctxFor(KEY));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
  });

  it("404s an unknown key (cannot enumerate arbitrary R2 paths)", async () => {
    const res = await handleImage(new Request("https://x"), env, ctxFor("9999/x/y/z.png"));
    expect(res.status).toBe(404);
  });

  it("400s a missing key", async () => {
    const res = await handleImage(new Request("https://x"), env, ctxFor());
    expect(res.status).toBe(400);
  });

  it("404s when R2 is not configured", async () => {
    const prev = (env as any).BUCKET;
    (env as any).BUCKET = undefined;
    const res = await handleImage(new Request("https://x"), env, ctxFor(KEY));
    (env as any).BUCKET = prev;
    expect(res.status).toBe(404);
  });
});
