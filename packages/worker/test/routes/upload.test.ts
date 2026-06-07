import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { handleUploadInfo, handleUpload } from "../../src/routes/upload";
import { hashToken } from "../../src/core/tokens";
import type { RouteCtx } from "../../src/router";

const TS = "2026-05-01T00:00:00.000Z";
const FUTURE = "2030-01-01T00:00:00.000Z";
const PAST = "2020-01-01T00:00:00.000Z";
const WS = 9006;
const SUB_A = 90061, SUB_B = 90062;
const PLAN_B = 90069;
const TAG = 90068;
const RAW_OK = "raw-token-ok";     // period 2026-06
const RAW_USED = "raw-token-used"; // period 2026-06 (expired)
const RAW_NOTE = "raw-token-note"; // period 2026-07

const ctxFor = (token: string): RouteCtx => ({ params: { token }, url: new URL("https://x/upload/" + token) });

beforeAll(async () => {
  const okHash = await hashToken(RAW_OK);
  const usedHash = await hashToken(RAW_USED);
  const noteHash = await hashToken(RAW_NOTE);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO workspaces (id,name,owner_id,channel_type,billing_day,settings,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(WS, "W", "o", "discord", 5, "{}", TS, TS),
    env.DB.prepare(`INSERT INTO users (id,workspace_id,display_name,created_at,updated_at) VALUES (?,?,?,?,?)`).bind(WS, WS, "Alice", TS, TS),
    env.DB.prepare(`INSERT INTO plans (id,workspace_id,name,provider,monthly_amount,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`).bind(WS, WS, "ChatGPT", "openai", 315, TS, TS),
    env.DB.prepare(`INSERT INTO plans (id,workspace_id,name,provider,monthly_amount,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`).bind(PLAN_B, WS, "Claude", "anthropic", 251, TS, TS),
    env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(SUB_A, WS, WS, WS, "2026-06-01", 5, TS, TS),
    env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(SUB_B, WS, WS, PLAN_B, "2026-06-01", 5, TS, TS),
    env.DB.prepare(`INSERT INTO channel_tags (id,workspace_id,name,type,sort_order,created_at) VALUES (?,?,?,?,?,?)`).bind(TAG, WS, "LINE Pay", "mobilepayment", 1, TS),
    // unbound tokens (one settlement covers all the user's subs).
    env.DB.prepare(`INSERT INTO upload_tokens (token_hash,workspace_id,user_id,period,expires_at,created_at) VALUES (?,?,?,?,?,?)`).bind(okHash, WS, WS, "2026-06", FUTURE, TS),
    env.DB.prepare(`INSERT INTO upload_tokens (token_hash,workspace_id,user_id,period,expires_at,created_at) VALUES (?,?,?,?,?,?)`).bind(usedHash, WS, WS, "2026-06", PAST, TS),
    env.DB.prepare(`INSERT INTO upload_tokens (token_hash,workspace_id,user_id,period,expires_at,created_at) VALUES (?,?,?,?,?,?)`).bind(noteHash, WS, WS, "2026-07", FUTURE, TS),
  ]);
});

function uploadReq(token: string, fields: Record<string, string | File>): Request {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return new Request(`https://x/upload/${token}`, { method: "POST", body: fd });
}
const pngFile = () => new File([new Uint8Array([1, 2, 3])], "s.png", { type: "image/png" });

describe("upload info", () => {
  it("returns period, subscriptions, and active channel tags", async () => {
    const res = await handleUploadInfo(new Request("https://x"), env, ctxFor(RAW_OK));
    const body = (await res.json()) as any;
    expect(body.valid).toBe(true);
    expect(body.period).toBe("2026-06");
    expect(body.user.display_name).toBe("Alice");
    expect(body.subscriptions.map((s: any) => s.id).sort()).toEqual([SUB_A, SUB_B]);
    expect(body.channel_tags.some((t: any) => t.id === TAG)).toBe(true);
  });

  it("404s an invalid token", async () => {
    const res = await handleUploadInfo(new Request("https://x"), env, ctxFor("nope"));
    expect(res.status).toBe(404);
  });

  it("reports proof_enabled per R2 configuration", async () => {
    const on = (await (await handleUploadInfo(new Request("https://x"), env, ctxFor(RAW_OK))).json()) as any;
    expect(on.proof_enabled).toBe(true);
    const prev = (env as any).BUCKET;
    (env as any).BUCKET = undefined;
    const off = (await (await handleUploadInfo(new Request("https://x"), env, ctxFor(RAW_OK))).json()) as any;
    (env as any).BUCKET = prev;
    expect(off.proof_enabled).toBe(false);
  });
});

describe("upload submit", () => {
  it("rejects an empty submission (no screenshot, note, or channel)", async () => {
    const res = await handleUpload(uploadReq(RAW_OK, {}), env, ctxFor(RAW_OK));
    expect(res.status).toBe(400);
  });

  it("rejects a non-image (token not yet spent)", async () => {
    const txt = new File(["hi"], "n.txt", { type: "text/plain" });
    const res = await handleUpload(uploadReq(RAW_OK, { screenshot: txt }), env, ctxFor(RAW_OK));
    expect(res.status).toBe(400);
  });

  it("screenshot path settles all subs and shares one key", async () => {
    const res = await handleUpload(
      uploadReq(RAW_OK, { screenshot: pngFile(), declared_channel_tag_id: String(TAG) }),
      env, ctxFor(RAW_OK)
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.has_proof).toBe(1);
    expect(body.paid_count).toBe(2);

    const rows = await env.DB.prepare("SELECT status, screenshot_key, declared_channel_tag_id FROM payments WHERE workspace_id=? AND period='2026-06'").bind(WS).all<{ status: string; screenshot_key: string; declared_channel_tag_id: number }>();
    expect(rows.results.length).toBe(2);
    expect(rows.results.every((p) => p.status === "paid")).toBe(true);
    expect(new Set(rows.results.map((p) => p.screenshot_key)).size).toBe(1);
    expect(rows.results.every((p) => p.declared_channel_tag_id === TAG)).toBe(true);
  });

  it("note-only settles all of the user's period subs and spends the token", async () => {
    const res = await handleUpload(
      uploadReq(RAW_NOTE, { note: "LINE 末五碼 12345" }),
      env, ctxFor(RAW_NOTE)
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.has_proof).toBe(0);
    expect(body.paid_count).toBe(2);
  });

  it("410s a used/expired token", async () => {
    const res = await handleUpload(uploadReq(RAW_USED, { note: "x" }), env, ctxFor(RAW_USED));
    expect(res.status).toBe(410);
  });

  it("reports has_proof=0 when R2 is absent even if a file is posted", async () => {
    const RAW = "raw-token-nor2";
    const h = await hashToken(RAW);
    await env.DB.prepare(`INSERT INTO upload_tokens (token_hash,workspace_id,user_id,period,expires_at,created_at) VALUES (?,?,?,?,?,?)`).bind(h, WS, WS, "2026-09", FUTURE, TS).run();
    const prev = (env as any).BUCKET;
    (env as any).BUCKET = undefined;
    const res = await handleUpload(uploadReq(RAW, { screenshot: pngFile() }), env, ctxFor(RAW));
    (env as any).BUCKET = prev;
    const body = (await res.json()) as any;
    expect(res.status).toBe(200);
    expect(body.has_proof).toBe(0);
  });
});
