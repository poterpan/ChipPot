import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { handleUploadInfo, handleUpload } from "../../src/routes/upload";
import { hashToken } from "../../src/core/tokens";
import { getPayment } from "../../src/core/payments";
import { getObject } from "../../src/core/storage";
import type { RouteCtx } from "../../src/router";

const TS = "2026-05-01T00:00:00.000Z";
const FUTURE = "2030-01-01T00:00:00.000Z";
const PAST = "2020-01-01T00:00:00.000Z";
const WS = 9006;
const SUB_A = 90061, SUB_B = 90062;
const PERIOD = "2026-06";
const RAW_OK = "raw-token-ok";
const RAW_USED = "raw-token-used";
const RAW_NOTE = "raw-token-note";

const ctxFor = (token: string): RouteCtx => ({ params: { token }, url: new URL("https://x/upload/" + token) });

beforeAll(async () => {
  const okHash = await hashToken(RAW_OK);
  const usedHash = await hashToken(RAW_USED);
  const noteHash = await hashToken(RAW_NOTE);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO workspaces (id,name,owner_id,channel_type,billing_day,settings,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(WS, "W", "o", "discord", 5, "{}", TS, TS),
    env.DB.prepare(`INSERT INTO users (id,workspace_id,display_name,created_at,updated_at) VALUES (?,?,?,?,?)`).bind(WS, WS, "Alice", TS, TS),
    env.DB.prepare(`INSERT INTO plans (id,workspace_id,name,provider,monthly_amount,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`).bind(WS, WS, "ChatGPT", "openai", 315, TS, TS),
    env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(SUB_A, WS, WS, WS, "2026-06-01", 5, TS, TS),
    env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(SUB_B, WS, WS, WS, "2026-06-01", 5, TS, TS),
    // unbound token (client must pick a subscription)
    env.DB.prepare(`INSERT INTO upload_tokens (token_hash,workspace_id,user_id,period,expires_at,created_at) VALUES (?,?,?,?,?,?)`).bind(okHash, WS, WS, PERIOD, FUTURE, TS),
    env.DB.prepare(`INSERT INTO upload_tokens (token_hash,workspace_id,user_id,period,expires_at,created_at) VALUES (?,?,?,?,?,?)`).bind(usedHash, WS, WS, PERIOD, PAST, TS),
    env.DB.prepare(`INSERT INTO upload_tokens (token_hash,workspace_id,user_id,period,expires_at,created_at) VALUES (?,?,?,?,?,?)`).bind(noteHash, WS, WS, PERIOD, FUTURE, TS),
  ]);
});

function uploadReq(token: string, fields: Record<string, string | File>): Request {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return new Request(`https://x/upload/${token}`, { method: "POST", body: fd });
}
const pngFile = () => new File([new Uint8Array([1, 2, 3])], "s.png", { type: "image/png" });

describe("upload info", () => {
  it("returns period + both subscription choices for an unbound token", async () => {
    const res = await handleUploadInfo(new Request("https://x"), env, ctxFor(RAW_OK));
    const body = (await res.json()) as any;
    expect(body.valid).toBe(true);
    expect(body.period).toBe(PERIOD);
    expect(body.user.display_name).toBe("Alice");
    expect(body.subscriptions.map((s: any) => s.id).sort()).toEqual([SUB_A, SUB_B]);
  });

  it("404s an invalid token", async () => {
    const res = await handleUploadInfo(new Request("https://x"), env, ctxFor("nope"));
    expect(res.status).toBe(404);
  });
});

describe("upload submit", () => {
  it("rejects an empty submission (no screenshot and no note)", async () => {
    const res = await handleUpload(uploadReq(RAW_OK, { subscription_id: String(SUB_A) }), env, ctxFor(RAW_OK));
    expect(res.status).toBe(400);
  });

  it("accepts a note-only submission (no screenshot)", async () => {
    const res = await handleUpload(
      uploadReq(RAW_NOTE, { subscription_id: String(SUB_B), note: "LINE 轉帳末五碼 12345" }),
      env, ctxFor(RAW_NOTE)
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.has_proof).toBe(0);
    const p = await getPayment(env.DB, body.payment_id);
    expect(p?.status).toBe("paid");
    expect(p?.has_proof).toBe(0);
    expect(p?.payment_note).toBe("LINE 轉帳末五碼 12345");
    expect(p?.source).toBe("user_web");
  });

  it("rejects a non-image", async () => {
    const txt = new File(["hi"], "n.txt", { type: "text/plain" });
    const res = await handleUpload(uploadReq(RAW_OK, { subscription_id: String(SUB_A), screenshot: txt }), env, ctxFor(RAW_OK));
    expect(res.status).toBe(400);
  });

  it("accepts a screenshot, marks paid, stores object, spends token", async () => {
    const res = await handleUpload(
      uploadReq(RAW_OK, { subscription_id: String(SUB_A), screenshot: pngFile(), note: "LINE Pay" }),
      env, ctxFor(RAW_OK)
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);

    const p = await getPayment(env.DB, body.payment_id);
    expect(p?.status).toBe("paid");
    expect(p?.has_proof).toBe(1);
    expect(p?.payment_note).toBe("LINE Pay");
    expect(await getObject(env.BUCKET, p!.screenshot_key!)).not.toBeNull();
  });

  it("410s a used/expired token", async () => {
    const res = await handleUpload(uploadReq(RAW_USED, { subscription_id: String(SUB_A), screenshot: pngFile() }), env, ctxFor(RAW_USED));
    expect(res.status).toBe(410);
  });
});
