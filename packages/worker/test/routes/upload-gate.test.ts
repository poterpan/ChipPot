import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { buildAdminRouter } from "../../src/routes/admin";
import { handleUpload } from "../../src/routes/upload";
import { hashToken, issueUploadToken } from "../../src/core/tokens";
import { claimNotification } from "../../src/core/notify";
import type { RouteCtx } from "../../src/router";

const TS = "2026-05-01T00:00:00.000Z";
const WS = 9840;
const PLAN = 9840, USER = 9840, SUB = 9840;
const UNOPENED = "2095-01";
const OPENED = "2095-02";
// The upload-link route always resolves the seeded workspace 1, so its fixture lives there.
const LINK_USER = 1;

const router = buildAdminRouter();
const IDENT = { email: "owner@example.com" };
function call(method: string, path: string, body?: unknown) {
  const init: RequestInit = { method };
  if (body !== undefined) { init.body = JSON.stringify(body); init.headers = { "content-type": "application/json" }; }
  return router.handle(new Request(`https://x${path}`, init), env, { identity: IDENT });
}

async function mintToken(period: string): Promise<string> {
  const { raw } = await issueUploadToken(env.DB, { workspaceId: WS, userId: USER, period, subscriptionId: null, ttlMs: 30 * 60 * 1000 });
  return raw;
}
const ctxFor = (token: string): RouteCtx => ({ params: { token }, url: new URL(`https://x/upload/${token}`) });
function uploadReq(fields: Record<string, string>): Request {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return new Request("https://x/upload/t", { method: "POST", body: fd });
}
async function tokenCount(): Promise<number> {
  const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM upload_tokens").first<{ n: number }>();
  return r!.n;
}

beforeAll(async () => {
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO workspaces (id,name,owner_id,channel_type,billing_day,settings,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(WS, "W", "o", "discord", 1, "{}", TS, TS),
    env.DB.prepare(`INSERT INTO users (id,workspace_id,display_name,created_at,updated_at) VALUES (?,?,?,?,?)`).bind(USER, WS, "U", TS, TS),
    env.DB.prepare(`INSERT INTO plans (id,workspace_id,name,provider,monthly_amount,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`).bind(PLAN, WS, "ChatGPT", "openai", 315, TS, TS),
    env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(SUB, WS, USER, PLAN, "2095-01-01", 1, TS, TS),
    // A real member of workspace 1, so an upload-link rejection can only come from the period check.
    env.DB.prepare(`INSERT INTO users (id,workspace_id,display_name,created_at,updated_at) VALUES (?,?,?,?,?)`).bind(LINK_USER, 1, "Link", TS, TS),
  ]);
  for (const p of [UNOPENED, OPENED]) {
    await env.DB.prepare(
      `INSERT INTO payments (workspace_id,subscription_id,period,period_start,period_end,due_date,amount,status,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(WS, SUB, p, `${p}-01`, `${p}-28`, `${p}-01`, 315, "pending", "cron", TS, TS).run();
  }
  await claimNotification(env.DB, { workspaceId: WS, type: "billing_opened", period: OPENED });
});

describe("POST /upload/:token 的開繳閘門", () => {
  it("未開繳的期別回 409 中文訊息，帳單維持 pending", async () => {
    const raw = await mintToken(UNOPENED);
    const res = await handleUpload(uploadReq({ note: "轉帳了" }), env, ctxFor(raw));
    expect(res.status).toBe(409);
    const body = (await res.json()) as any;
    expect(body.code).toBe("payment");
    expect(body.error).toContain("尚未開放");
    const p = await env.DB.prepare("SELECT status FROM payments WHERE subscription_id=? AND period=?").bind(SUB, UNOPENED).first<{ status: string }>();
    expect(p!.status).toBe("pending");
  });

  it("被閘門擋下時不消耗 token", async () => {
    const raw = await mintToken(UNOPENED);
    expect((await handleUpload(uploadReq({ note: "轉帳了" }), env, ctxFor(raw))).status).toBe(409);
    // The link must survive the rejection — it is spendable once the admin opens the period.
    const row = await env.DB.prepare("SELECT used_at FROM upload_tokens WHERE token_hash = ?")
      .bind(await hashToken(raw)).first<{ used_at: string | null }>();
    expect(row!.used_at).toBeNull();
  });

  it("已開繳的期別照常結算", async () => {
    const raw = await mintToken(OPENED);
    const res = await handleUpload(uploadReq({ note: "轉帳了" }), env, ctxFor(raw));
    expect(res.status).toBe(200);
    const p = await env.DB.prepare("SELECT status FROM payments WHERE subscription_id=? AND period=?").bind(SUB, OPENED).first<{ status: string }>();
    expect(p!.status).toBe("paid");
  });
});

describe("POST /admin/upload-link 的 period 驗證", () => {
  it("格式錯誤的 period 回 400，不會鑄出 token", async () => {
    const before = await tokenCount();
    const res = await call("POST", "/admin/upload-link", { user_id: LINK_USER, period: "2026-7" });
    expect(res!.status).toBe(400);
    expect(((await res!.json()) as any).error).toContain("YYYY-MM");
    expect(await tokenCount()).toBe(before);
  });

  it("格式正確的 period 照常鑄出連結（證明 400 來自格式而非成員）", async () => {
    const before = await tokenCount();
    const res = await call("POST", "/admin/upload-link", { user_id: LINK_USER, period: "2026-07" });
    expect(res!.status).toBe(201);
    expect(await tokenCount()).toBe(before + 1);
  });
});
