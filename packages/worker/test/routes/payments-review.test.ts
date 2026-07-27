import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { buildAdminRouter } from "../../src/routes/admin";

const TS = "2026-05-01T00:00:00.000Z";
const WS = 1;                    // wsId() ALWAYS returns the seeded default workspace 1
const U_A = 9400, U_B = 9401;    // two members, so the user filter has something to exclude
const SUB_A1 = 9410, SUB_A2 = 9411, SUB_B1 = 9412;
const P_A1 = 9420, P_A2 = 9421, P_B1 = 9422, P_A_OTHER = 9423;
const PERIOD = "2028-03";
const router = buildAdminRouter();
const IDENT = { email: "owner@example.com" };

// Mirrors test/routes/admin.test.ts: ctx is { identity }, no workspace header (wsId ignores it).
function call(method: string, path: string, body?: unknown) {
  const init: RequestInit = { method };
  if (body !== undefined) { init.body = JSON.stringify(body); init.headers = { "content-type": "application/json" }; }
  return router.handle(new Request(`https://x${path}`, init), env, { identity: IDENT });
}

function sub(id: number, userId: number) {
  return env.DB.prepare(
    `INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?)`
  ).bind(id, WS, userId, 1, "2028-01-01", 5, TS, TS);
}

// One shared screenshot key across a member's rows — that is what a single settle produces.
function pay(id: number, subId: number, period: string, status: string, declaredTag: number | null) {
  return env.DB.prepare(
    `INSERT INTO payments (id,workspace_id,subscription_id,period,period_start,period_end,due_date,amount,
        status,source,declared_channel_tag_id,has_proof,screenshot_key,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(id, WS, subId, period, `${period}-01`, `${period}-28`, `${period}-05`, 315,
         status, "user_slash", declaredTag, 1, "shot-9420", TS, TS);
}

beforeAll(async () => {
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO users (id,workspace_id,display_name,created_at,updated_at) VALUES (?,?,?,?,?)`).bind(U_A, WS, "阿明", TS, TS),
    env.DB.prepare(`INSERT INTO users (id,workspace_id,display_name,created_at,updated_at) VALUES (?,?,?,?,?)`).bind(U_B, WS, "小華", TS, TS),
    sub(SUB_A1, U_A), sub(SUB_A2, U_A), sub(SUB_B1, U_B),
    pay(P_A1, SUB_A1, PERIOD, "paid", 1),      // declared LINE Pay
    pay(P_A2, SUB_A2, PERIOD, "paid", null),   // no declared channel
    pay(P_B1, SUB_B1, PERIOD, "paid", 1),      // another member, same period
    pay(P_A_OTHER, SUB_A1, "2028-04", "paid", 1), // same member, another period
  ]);
});

describe("GET /admin/payments filters", () => {
  it("user_id + period returns only that member's rows for that period", async () => {
    const res = await call("GET", `/admin/payments?user_id=${U_A}&period=${PERIOD}`);
    expect(res!.status).toBe(200);
    const ids = ((await res!.json()) as any).payments.map((p: any) => p.id).sort();
    expect(ids).toEqual([P_A1, P_A2]);
  });

  it("returns user_id on every row so the UI can link to a member's review", async () => {
    const res = await call("GET", `/admin/payments?user_id=${U_A}&period=${PERIOD}`);
    const rows = ((await res!.json()) as any).payments;
    expect(rows.every((p: any) => p.user_id === U_A)).toBe(true);
    // user_id is an unconditional SELECT column, so the plain toolbar filters carry it too —
    // that is what lets a period/status listing link straight into a member's review.
    const toolbar = await call("GET", `/admin/payments?period=${PERIOD}&status=paid`);
    const toolbarRows = ((await toolbar!.json()) as any).payments;
    expect(toolbarRows.map((p: any) => p.user_id).sort()).toEqual([U_A, U_A, U_B]);
  });

  it("id resolves exactly one payment, joined like the list (legacy deep link)", async () => {
    const res = await call("GET", `/admin/payments?id=${P_B1}`);
    const rows = ((await res!.json()) as any).payments;
    expect(rows.length).toBe(1);
    expect(rows[0].id).toBe(P_B1);
    expect(rows[0].user_name).toBe("小華");
    expect(rows[0].declared_channel_tag_name).toBe("LINE Pay");
  });

  it("400s on a non-positive-integer id or user_id", async () => {
    expect((await call("GET", "/admin/payments?id=abc"))!.status).toBe(400);
    expect((await call("GET", "/admin/payments?user_id=0"))!.status).toBe(400);
  });
});
