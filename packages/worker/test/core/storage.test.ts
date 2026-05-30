import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import {
  buildScreenshotKey, extForContentType, assertImageOk, InvalidImage,
  putObject, getObject, deleteObject,
  submitProofWithToken, TokenUnusable, NoEligiblePayment,
} from "../../src/core/storage";
import { getPayment } from "../../src/core/payments";

const TS = "2026-05-01T00:00:00.000Z";
const FUTURE = "2030-01-01T00:00:00.000Z";
const PAST = "2020-01-01T00:00:00.000Z";
const WS = 9005;
const SUB1 = 9005;   // == user/workspace id-space
const SUB2 = 90051;  // a second subscription for the same user
const PERIOD = "2026-06";
const PREFIX = `${WS}/${PERIOD}/${WS}/`;

beforeAll(async () => {
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO workspaces (id,name,owner_id,channel_type,billing_day,settings,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(WS, "W", "o", "discord", 5, "{}", TS, TS),
    env.DB.prepare(`INSERT INTO users (id,workspace_id,display_name,created_at,updated_at) VALUES (?,?,?,?,?)`).bind(WS, WS, "U", TS, TS),
    env.DB.prepare(`INSERT INTO plans (id,workspace_id,name,provider,monthly_amount,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`).bind(WS, WS, "ChatGPT", "openai", 315, TS, TS),
    env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(SUB1, WS, WS, WS, "2026-06-01", 5, TS, TS),
    env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(SUB2, WS, WS, WS, "2026-06-01", 5, TS, TS),
    // tokens bound to SUB1 unless noted
    env.DB.prepare(`INSERT INTO upload_tokens (token_hash,workspace_id,user_id,period,subscription_id,expires_at,created_at) VALUES (?,?,?,?,?,?,?)`).bind("hash_ok", WS, WS, PERIOD, SUB1, FUTURE, TS),
    env.DB.prepare(`INSERT INTO upload_tokens (token_hash,workspace_id,user_id,period,subscription_id,expires_at,created_at) VALUES (?,?,?,?,?,?,?)`).bind("hash_ok2", WS, WS, PERIOD, SUB1, FUTURE, TS),
    env.DB.prepare(`INSERT INTO upload_tokens (token_hash,workspace_id,user_id,period,subscription_id,expires_at,created_at) VALUES (?,?,?,?,?,?,?)`).bind("hash_expired", WS, WS, PERIOD, SUB1, PAST, TS),
    env.DB.prepare(`INSERT INTO upload_tokens (token_hash,workspace_id,user_id,period,subscription_id,expires_at,created_at) VALUES (?,?,?,?,?,?,?)`).bind("hash_bound_sub1", WS, WS, PERIOD, SUB1, FUTURE, TS),
  ]);
});

const bytes = new Uint8Array([1, 2, 3, 4, 5]);

async function countProofs(): Promise<number> {
  const listed = await env.BUCKET.list({ prefix: PREFIX });
  return listed.objects.length;
}

function submit(tokenHash: string, subscriptionId: number) {
  return submitProofWithToken(env, {
    tokenHash, subscriptionId, workspaceId: WS, userId: WS, period: PERIOD,
    body: bytes, ext: "png", contentType: "image/png", source: "user_web",
  });
}

describe("storage helpers", () => {
  it("buildScreenshotKey follows {ws}/{period}/{user}/{stamp}.{ext}", () => {
    expect(buildScreenshotKey(1, "2026-06", 7, "png", "abc")).toBe("1/2026-06/7/abc.png");
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

// These run in order; per-file storage isolation means state carries across `it`.
describe("submitProofWithToken (compensation flow)", () => {
  it("happy path: claims token, marks payment paid+proof, stores a unique object", async () => {
    const res = await submit("hash_ok", SUB1);
    expect(res.screenshotKey).toMatch(new RegExp(`^${PREFIX}[0-9a-f-]{36}\\.png$`));

    const p = await getPayment(env.DB, res.paymentId);
    expect(p?.status).toBe("paid");
    expect(p?.has_proof).toBe(1);
    expect(p?.screenshot_key).toBe(res.screenshotKey);
    expect(await getObject(env.BUCKET, res.screenshotKey)).not.toBeNull();

    const tok = await env.DB.prepare("SELECT used_at FROM upload_tokens WHERE token_hash='hash_ok'")
      .first<{ used_at: string | null }>();
    expect(tok?.used_at).not.toBeNull();
    expect(await countProofs()).toBe(1);
  });

  it("rejects a fresh token once the payment is already paid (no paid->paid), no orphan", async () => {
    await expect(submit("hash_ok2", SUB1)).rejects.toBeInstanceOf(NoEligiblePayment);
    expect(await countProofs()).toBe(1); // failed upload was compensated
    const tok = await env.DB.prepare("SELECT used_at FROM upload_tokens WHERE token_hash='hash_ok2'")
      .first<{ used_at: string | null }>();
    expect(tok?.used_at).toBeNull(); // token NOT consumed
  });

  it("rejects reuse of a spent token, no orphan", async () => {
    await expect(submit("hash_ok", SUB1)).rejects.toBeInstanceOf(TokenUnusable);
    expect(await countProofs()).toBe(1);
  });

  it("rejects an expired token, no orphan", async () => {
    await expect(submit("hash_expired", SUB1)).rejects.toBeInstanceOf(TokenUnusable);
    expect(await countProofs()).toBe(1);
  });

  it("rejects a token bound to a different subscription (cross-payment guard), no orphan", async () => {
    // hash_bound_sub1 is bound to SUB1; using it for SUB2 must fail.
    await expect(submit("hash_bound_sub1", SUB2)).rejects.toBeInstanceOf(TokenUnusable);
    expect(await countProofs()).toBe(1);
    const tok = await env.DB.prepare("SELECT used_at FROM upload_tokens WHERE token_hash='hash_bound_sub1'")
      .first<{ used_at: string | null }>();
    expect(tok?.used_at).toBeNull();
  });
});
