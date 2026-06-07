import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import {
  settleUserPeriod, getObject, TokenUnusable, NoEligiblePayment,
} from "../../src/core/storage";

const TS = "2026-05-01T00:00:00.000Z";
const FUTURE = "2030-01-01T00:00:00.000Z";
const WS = 9021;
const SUB_A = 9021, SUB_B = 90211;
const PLAN_B = 90211;
const TAG = 9021;
const PERIOD = "2027-02";

beforeAll(async () => {
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO workspaces (id,name,owner_id,channel_type,billing_day,settings,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(WS, "W", "o", "discord", 5, "{}", TS, TS),
    env.DB.prepare(`INSERT INTO users (id,workspace_id,display_name,created_at,updated_at) VALUES (?,?,?,?,?)`).bind(WS, WS, "U", TS, TS),
    env.DB.prepare(`INSERT INTO plans (id,workspace_id,name,provider,monthly_amount,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`).bind(WS, WS, "ChatGPT", "openai", 315, TS, TS),
    env.DB.prepare(`INSERT INTO plans (id,workspace_id,name,provider,monthly_amount,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`).bind(PLAN_B, WS, "Claude", "anthropic", 251, TS, TS),
    env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(SUB_A, WS, WS, WS, "2027-02-01", 5, TS, TS),
    env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(SUB_B, WS, WS, PLAN_B, "2027-02-01", 5, TS, TS),
    env.DB.prepare(`INSERT INTO channel_tags (id,workspace_id,name,type,sort_order,created_at) VALUES (?,?,?,?,?,?)`).bind(TAG, WS, "LINE Pay", "mobilepayment", 1, TS),
    // unbound tokens for the web-path tests (period 2027-04). settleUserPeriod takes the
    // token HASH directly, so these literals stand in for the stored sha256(raw).
    env.DB.prepare(`INSERT INTO upload_tokens (token_hash,workspace_id,user_id,period,expires_at,created_at) VALUES (?,?,?,?,?,?)`).bind("settle-ok-hash", WS, WS, "2027-04", FUTURE, TS),
    env.DB.prepare(`INSERT INTO upload_tokens (token_hash,workspace_id,user_id,period,expires_at,created_at) VALUES (?,?,?,?,?,?)`).bind("settle-bad-hash", WS, WS, "2027-04", FUTURE, TS),
  ]);
});

describe("settleUserPeriod — Discord direct path", () => {
  it("settles all of a user's period subs at once, no proof, records declared channel", async () => {
    const r = await settleUserPeriod(env, {
      workspaceId: WS, userId: WS, period: PERIOD,
      declaredChannelTagId: TAG, source: "user_slash",
    });
    expect(r.paidCount).toBe(2);
    expect(r.totalAmount).toBe(566);
    expect(r.screenshotKey).toBeNull();

    const rows = await env.DB.prepare(
      "SELECT status, has_proof, declared_channel_tag_id, source FROM payments WHERE workspace_id=? AND period=?"
    ).bind(WS, PERIOD).all<{ status: string; has_proof: number; declared_channel_tag_id: number; source: string }>();
    expect(rows.results.every((p) => p.status === "paid")).toBe(true);
    expect(rows.results.every((p) => p.declared_channel_tag_id === TAG)).toBe(true);
    expect(rows.results.every((p) => p.source === "user_slash")).toBe(true);
  });

  it("is a no-op when everything is already paid (alreadyPaidCount reported)", async () => {
    const r = await settleUserPeriod(env, {
      workspaceId: WS, userId: WS, period: PERIOD, source: "user_slash",
    });
    expect(r.paidCount).toBe(0);
    expect(r.alreadyPaidCount).toBe(2);
  });

  it("compensates the proof object when nothing was settled (already paid)", async () => {
    const before = (await env.BUCKET.list({ prefix: `${WS}/${PERIOD}/${WS}/` })).objects.length;
    const r = await settleUserPeriod(env, {
      workspaceId: WS, userId: WS, period: PERIOD, source: "user_slash",
      proof: { body: new Uint8Array([7]), ext: "png", contentType: "image/png" },
    });
    expect(r.paidCount).toBe(0);
    expect(r.screenshotKey).toBeNull(); // not orphaned
    const after = (await env.BUCKET.list({ prefix: `${WS}/${PERIOD}/${WS}/` })).objects.length;
    expect(after).toBe(before);
  });

  it("settles without a proof object when R2 is not configured (has_proof=0)", async () => {
    const prev = (env as any).BUCKET;
    (env as any).BUCKET = undefined;
    const r = await settleUserPeriod(env, {
      workspaceId: WS, userId: WS, period: "2027-05", source: "user_slash",
      proof: { body: new Uint8Array([1, 2, 3]), ext: "png", contentType: "image/png" },
    });
    (env as any).BUCKET = prev;
    expect(r.paidCount).toBe(2);
    expect(r.screenshotKey).toBeNull();
    const rows = await env.DB.prepare("SELECT has_proof, screenshot_key FROM payments WHERE workspace_id=? AND period='2027-05'").bind(WS).all<{ has_proof: number; screenshot_key: string | null }>();
    expect(rows.results.every((p) => p.has_proof === 0 && p.screenshot_key === null)).toBe(true);
  });

  it("shares ONE screenshot key across all settled rows", async () => {
    const r = await settleUserPeriod(env, {
      workspaceId: WS, userId: WS, period: "2027-03", source: "user_slash",
      proof: { body: new Uint8Array([1, 2, 3]), ext: "png", contentType: "image/png" },
    });
    expect(r.paidCount).toBe(2);
    expect(r.screenshotKey).toMatch(new RegExp(`^${WS}/2027-03/${WS}/[0-9a-f-]{36}\\.png$`));
    const rows = await env.DB.prepare(
      "SELECT screenshot_key, has_proof FROM payments WHERE workspace_id=? AND period='2027-03'"
    ).bind(WS).all<{ screenshot_key: string; has_proof: number }>();
    expect(new Set(rows.results.map((x) => x.screenshot_key)).size).toBe(1);
    expect(rows.results.every((x) => x.has_proof === 1)).toBe(true);
    expect(await getObject(env.BUCKET, r.screenshotKey!)).not.toBeNull();
  });
});

describe("settleUserPeriod — web token path", () => {
  it("claims the token once and settles all subs for the period", async () => {
    const r = await settleUserPeriod(env, {
      workspaceId: WS, userId: WS, period: "2027-04", source: "user_web",
      declaredChannelTagId: TAG, tokenHash: "settle-ok-hash",
      proof: { body: new Uint8Array([9]), ext: "png", contentType: "image/png" },
    });
    expect(r.paidCount).toBe(2);
    const tok = await env.DB.prepare("SELECT used_at FROM upload_tokens WHERE token_hash=?")
      .bind("settle-ok-hash").first<{ used_at: string | null }>();
    expect(tok?.used_at).not.toBeNull();
  });

  it("rejects reuse of a spent token and leaves no orphan object", async () => {
    const before = (await env.BUCKET.list({ prefix: `${WS}/2027-04/${WS}/` })).objects.length;
    await expect(settleUserPeriod(env, {
      workspaceId: WS, userId: WS, period: "2027-04", source: "user_web",
      tokenHash: "settle-ok-hash",
      proof: { body: new Uint8Array([9]), ext: "png", contentType: "image/png" },
    })).rejects.toBeInstanceOf(TokenUnusable);
    const after = (await env.BUCKET.list({ prefix: `${WS}/2027-04/${WS}/` })).objects.length;
    expect(after).toBe(before); // failed upload compensated
  });

  it("rejects when nothing is settleable (already paid) without consuming the token", async () => {
    await expect(settleUserPeriod(env, {
      workspaceId: WS, userId: WS, period: "2027-04", source: "user_web",
      tokenHash: "settle-bad-hash",
    })).rejects.toBeInstanceOf(NoEligiblePayment);
    const tok = await env.DB.prepare("SELECT used_at FROM upload_tokens WHERE token_hash=?")
      .bind("settle-bad-hash").first<{ used_at: string | null }>();
    expect(tok?.used_at).toBeNull();
  });
});
