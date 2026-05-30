import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import {
  buildScreenshotKey, extForContentType, assertImageOk, InvalidImage,
  putObject, getObject, deleteObject,
  submitProofWithToken, TokenUnusable,
} from "../../src/core/storage";
import { getPayment } from "../../src/core/payments";

const TS = "2026-05-01T00:00:00.000Z";
const FUTURE = "2030-01-01T00:00:00.000Z";
const PAST = "2020-01-01T00:00:00.000Z";
const WS = 9005;

beforeAll(async () => {
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO workspaces (id,name,owner_id,channel_type,billing_day,settings,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(WS, "W", "o", "discord", 5, "{}", TS, TS),
    env.DB.prepare(`INSERT INTO users (id,workspace_id,display_name,created_at,updated_at) VALUES (?,?,?,?,?)`).bind(WS, WS, "U", TS, TS),
    env.DB.prepare(`INSERT INTO plans (id,workspace_id,name,provider,monthly_amount,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`).bind(WS, WS, "ChatGPT", "openai", 315, TS, TS),
    env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(WS, WS, WS, WS, "2026-06-01", 5, TS, TS),
    env.DB.prepare(`INSERT INTO upload_tokens (token_hash,workspace_id,user_id,period,subscription_id,expires_at,created_at) VALUES (?,?,?,?,?,?,?)`).bind("hash_ok", WS, WS, "2026-06", WS, FUTURE, TS),
    env.DB.prepare(`INSERT INTO upload_tokens (token_hash,workspace_id,user_id,period,subscription_id,expires_at,created_at) VALUES (?,?,?,?,?,?,?)`).bind("hash_expired", WS, WS, "2026-06", WS, PAST, TS),
  ]);
});

const bytes = new Uint8Array([1, 2, 3, 4, 5]);

describe("storage helpers", () => {
  it("buildScreenshotKey follows {ws}/{period}/{user}/{stamp}.{ext}", () => {
    expect(buildScreenshotKey(1, "2026-06", 7, "png", "1717000000000")).toBe("1/2026-06/7/1717000000000.png");
  });

  it("extForContentType maps image types", () => {
    expect(extForContentType("image/png")).toBe("png");
    expect(extForContentType("image/jpeg")).toBe("jpg");
    expect(extForContentType("image/webp")).toBe("webp");
  });

  it("assertImageOk accepts allowed types and rejects others/oversize", () => {
    expect(() => assertImageOk("image/png", 1000)).not.toThrow();
    expect(() => assertImageOk("application/pdf", 1000)).toThrow(InvalidImage);
    expect(() => assertImageOk("image/png", 0)).toThrow(InvalidImage);
    expect(() => assertImageOk("image/png", 50 * 1024 * 1024)).toThrow(InvalidImage);
  });

  it("put/get/delete round trip", async () => {
    const key = "9005/test/obj.bin";
    await putObject(env.BUCKET, key, bytes, "application/octet-stream");
    const got = await getObject(env.BUCKET, key);
    expect(got).not.toBeNull();
    expect(new Uint8Array(await got!.arrayBuffer())).toEqual(bytes);
    await deleteObject(env.BUCKET, key);
    expect(await getObject(env.BUCKET, key)).toBeNull();
  });
});

describe("submitProofWithToken (compensation flow)", () => {
  it("happy path: claims token, marks payment paid+proof, stores object", async () => {
    const res = await submitProofWithToken(env, {
      tokenHash: "hash_ok", subscriptionId: WS, workspaceId: WS, userId: WS,
      period: "2026-06", body: bytes, ext: "png", contentType: "image/png",
      source: "user_web", stamp: "stamp1",
    });
    expect(res.screenshotKey).toBe("9005/2026-06/9005/stamp1.png");

    const p = await getPayment(env.DB, res.paymentId);
    expect(p?.status).toBe("paid");
    expect(p?.has_proof).toBe(1);
    expect(p?.screenshot_key).toBe(res.screenshotKey);

    expect(await getObject(env.BUCKET, res.screenshotKey)).not.toBeNull();

    const tok = await env.DB.prepare("SELECT used_at FROM upload_tokens WHERE token_hash = 'hash_ok'")
      .first<{ used_at: string | null }>();
    expect(tok?.used_at).not.toBeNull();
  });

  it("reuse of a spent token throws and compensates (deletes R2 object)", async () => {
    const key = "9005/2026-06/9005/stamp2.png";
    await expect(submitProofWithToken(env, {
      tokenHash: "hash_ok", subscriptionId: WS, workspaceId: WS, userId: WS,
      period: "2026-06", body: bytes, ext: "png", contentType: "image/png",
      source: "user_web", stamp: "stamp2",
    })).rejects.toBeInstanceOf(TokenUnusable);
    expect(await getObject(env.BUCKET, key)).toBeNull();
  });

  it("expired token throws and compensates", async () => {
    const key = "9005/2026-06/9005/stamp3.png";
    await expect(submitProofWithToken(env, {
      tokenHash: "hash_expired", subscriptionId: WS, workspaceId: WS, userId: WS,
      period: "2026-06", body: bytes, ext: "png", contentType: "image/png",
      source: "user_web", stamp: "stamp3",
    })).rejects.toBeInstanceOf(TokenUnusable);
    expect(await getObject(env.BUCKET, key)).toBeNull();
  });
});
