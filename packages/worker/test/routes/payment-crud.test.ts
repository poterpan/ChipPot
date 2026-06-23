import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { buildAdminRouter } from "../../src/routes/admin";

const TS = "2026-05-01T00:00:00.000Z";
const WS = 1;                 // wsId() ALWAYS returns the seeded default workspace 1 (single-tenant MVP) — ignores ctx
const U = 9200, SUB = 9200;   // high ids; baseline (ws1 + plan 1 = ChatGPT 315) comes from 0002_seed.sql
const router = buildAdminRouter();
const IDENT = { email: "owner@example.com" };
// Mirror test/routes/admin.test.ts exactly: ctx is { identity }, no workspace header (wsId ignores it).
function call(method: string, path: string, body?: unknown) {
  const init: RequestInit = { method };
  if (body !== undefined) { init.body = JSON.stringify(body); init.headers = { "content-type": "application/json" }; }
  return router.handle(new Request(`https://x${path}`, init), env, { identity: IDENT });
}

beforeAll(async () => {
  await env.DB.batch([
    // ws 1 + plan 1 already seeded by 0002_seed.sql; add only our member/sub/payment under ws 1.
    env.DB.prepare(`INSERT INTO users (id,workspace_id,display_name,created_at,updated_at) VALUES (?,?,?,?,?)`).bind(U,WS,"U",TS,TS),
    env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(SUB,WS,U,1,"2027-01-01",5,TS,TS),
    env.DB.prepare(`INSERT INTO payments (id,workspace_id,subscription_id,period,period_start,period_end,due_date,amount,status,source,verified_by,verified_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(9201,WS,SUB,"2027-01","2027-01-01","2027-01-31","2027-01-05",315,"verified","cron","admin",TS,TS,TS),
  ]);
});

describe("POST /admin/payments/:id/unverify", () => {
  it("reverts verified -> pending", async () => {
    const res = await call("POST", "/admin/payments/9201/unverify");
    expect(res!.status).toBe(200);
    const row = await env.DB.prepare("SELECT status, verified_by FROM payments WHERE id = ?").bind(9201).first<{status:string;verified_by:string|null}>();
    expect(row?.status).toBe("pending");
    expect(row?.verified_by).toBeNull();
  });
  it("returns 409 when not verified", async () => {
    const res = await call("POST", "/admin/payments/9201/unverify"); // already pending now
    expect(res!.status).toBe(409);
  });
});
