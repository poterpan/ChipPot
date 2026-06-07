import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { runRetention } from "../../src/core/retention";
import { getObject, putObject } from "../../src/core/storage";

const TS = "2026-05-01T00:00:00.000Z";
const WS = 9023;
const SUB = 9023;
const NOW = new Date("2026-05-01T00:00:00.000Z"); // retention cutoff = 24mo before
const OLD = "2023-01-01T00:00:00.000Z"; // > 24mo before NOW -> eligible
const SHARED = "shared-key-9023";
const SOLO = "solo-key-9023";

beforeAll(async () => {
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO workspaces (id,name,owner_id,channel_type,billing_day,settings,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(WS, "W", "o", "discord", 5, "{}", TS, TS),
    env.DB.prepare(`INSERT INTO users (id,workspace_id,display_name,created_at,updated_at) VALUES (?,?,?,?,?)`).bind(WS, WS, "U", TS, TS),
    env.DB.prepare(`INSERT INTO plans (id,workspace_id,name,provider,monthly_amount,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`).bind(WS, WS, "P", "openai", 315, TS, TS),
    env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(SUB, WS, WS, WS, "2023-01-01", 5, TS, TS),
    // Two OLD payments sharing SHARED key (both eligible) + one OLD with SOLO key.
    env.DB.prepare(`INSERT INTO payments (workspace_id,subscription_id,period,period_start,period_end,due_date,amount,status,has_proof,screenshot_key,paid_at,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(WS, SUB, "2023-01", "2023-01-01", "2023-01-31", "2023-01-05", 315, "verified", 1, SHARED, OLD, "user_web", TS, TS),
    env.DB.prepare(`INSERT INTO payments (workspace_id,subscription_id,period,period_start,period_end,due_date,amount,status,has_proof,screenshot_key,paid_at,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(WS, SUB, "2023-02", "2023-02-01", "2023-02-28", "2023-02-05", 315, "verified", 1, SHARED, OLD, "user_web", TS, TS),
    env.DB.prepare(`INSERT INTO payments (workspace_id,subscription_id,period,period_start,period_end,due_date,amount,status,has_proof,screenshot_key,paid_at,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(WS, SUB, "2023-03", "2023-03-01", "2023-03-31", "2023-03-05", 315, "verified", 1, SOLO, OLD, "user_web", TS, TS),
  ]);
  await putObject(env.BUCKET, SHARED, new Uint8Array([1]), "image/png");
  await putObject(env.BUCKET, SOLO, new Uint8Array([2]), "image/png");
});

describe("runRetention reference-counting", () => {
  it("deletes the R2 object only after the LAST referencing payment is cleared", async () => {
    const cleared = await runRetention(env, WS, 24, NOW);
    expect(cleared).toBe(3); // all three D1 rows cleared

    // both shared rows nulled
    const shared = await env.DB.prepare("SELECT screenshot_key FROM payments WHERE screenshot_key=?").bind(SHARED).all();
    expect(shared.results.length).toBe(0);
    // object gone exactly once (ref count reached 0)
    expect(await getObject(env.BUCKET, SHARED)).toBeNull();
    expect(await getObject(env.BUCKET, SOLO)).toBeNull();
  });

  it("is a no-op when R2 is not configured (returns 0, keeps the row + object)", async () => {
    const KEY = "noR2-key-9023";
    await env.DB.prepare(`INSERT INTO payments (workspace_id,subscription_id,period,period_start,period_end,due_date,amount,status,has_proof,screenshot_key,paid_at,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(WS, SUB, "2023-05", "2023-05-01", "2023-05-31", "2023-05-05", 315, "verified", 1, KEY, OLD, "user_web", TS, TS).run();
    await putObject(env.BUCKET, KEY, new Uint8Array([4]), "image/png");
    const prev = (env as any).BUCKET;
    (env as any).BUCKET = undefined;
    const cleared = await runRetention(env, WS, 24, NOW);
    (env as any).BUCKET = prev;
    expect(cleared).toBe(0);
    const row = await env.DB.prepare("SELECT screenshot_key FROM payments WHERE workspace_id=? AND period='2023-05'").bind(WS).first<{ screenshot_key: string | null }>();
    expect(row?.screenshot_key).toBe(KEY);
    expect(await getObject(env.BUCKET, KEY)).not.toBeNull();
    // Clean up so this row doesn't affect subsequent retention tests in this file.
    await env.DB.prepare("DELETE FROM payments WHERE workspace_id=? AND period='2023-05'").bind(WS).run();
    await env.BUCKET.delete(KEY);
  });

  it("keeps the R2 object when a non-expired payment still references the key", async () => {
    const KEY = "mixed-key-9023";
    const RECENT = "2026-04-15T00:00:00.000Z"; // within 24mo of NOW -> NOT eligible
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO payments (workspace_id,subscription_id,period,period_start,period_end,due_date,amount,status,has_proof,screenshot_key,paid_at,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(WS, SUB, "2023-04", "2023-04-01", "2023-04-30", "2023-04-05", 315, "verified", 1, KEY, OLD, "user_web", TS, TS),
      env.DB.prepare(`INSERT INTO payments (workspace_id,subscription_id,period,period_start,period_end,due_date,amount,status,has_proof,screenshot_key,paid_at,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(WS, SUB, "2026-04", "2026-04-01", "2026-04-30", "2026-04-05", 315, "verified", 1, KEY, RECENT, "user_web", TS, TS),
    ]);
    await putObject(env.BUCKET, KEY, new Uint8Array([3]), "image/png");

    const cleared = await runRetention(env, WS, 24, NOW);
    expect(cleared).toBe(1); // only the OLD 2023-04 row cleared
    expect(await getObject(env.BUCKET, KEY)).not.toBeNull(); // still referenced by 2026-04
  });
});
