import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { buildAdminRouter } from "../../src/routes/admin";

const TS = "2026-05-01T00:00:00.000Z";
const WS = 1;                    // wsId() ALWAYS returns the seeded default workspace 1
const U_A = 9400, U_B = 9401;    // two members, so the user filter has something to exclude
const WS_OTHER = 9490, U_OTHER_WS = 9402; // a member of another workspace: must be invisible here
const U_C = 9403;                // the fault-injection member, untouched by every other test
const SUB_A1 = 9410, SUB_A2 = 9411, SUB_B1 = 9412;
const SUB_C1 = 9413, SUB_C2 = 9414, SUB_C3 = 9415;
const P_A1 = 9420, P_A2 = 9421, P_B1 = 9422, P_A_OTHER = 9423;
const P_C1 = 9430, P_C2 = 9431, P_C3 = 9432;
const PERIOD = "2028-03";
const PERIOD_C = "2028-05";      // U_C's own period, so the toolbar-filter tests never see these rows
const router = buildAdminRouter();
const IDENT = { email: "owner@example.com" };

// Mirrors test/routes/admin.test.ts: ctx is { identity }, no workspace header (wsId ignores it).
// `db` swaps the DB binding for a fault-injecting handle (see dbFailingOn).
function call(method: string, path: string, body?: unknown, db?: D1Database) {
  const init: RequestInit = { method };
  if (body !== undefined) { init.body = JSON.stringify(body); init.headers = { "content-type": "application/json" }; }
  const e = db ? ({ ...env, DB: db } as typeof env) : env;
  return router.handle(new Request(`https://x${path}`, init), e, { identity: IDENT });
}

/**
 * A DB handle that lets exactly one statement blow up: the `nth` prepare whose SQL contains
 * `sqlFragment` fails on .run(). D1 can't be faulted from inside the real runtime any other way,
 * and the verify-all sweep is deliberately non-atomic, so this is how a batch gets cut in half
 * mid-flight. Only the methods the worker actually calls are forwarded.
 */
function dbFailingOn(sqlFragment: string, nth: number): D1Database {
  let matched = 0;
  const wrap = (stmt: D1PreparedStatement, doomed: boolean): D1PreparedStatement => ({
    bind: (...args: unknown[]) => wrap(stmt.bind(...args), doomed),
    run: async () => {
      if (doomed) throw new Error("D1_ERROR: 模擬硬錯誤");
      return stmt.run();
    },
    first: (col?: string) => (col === undefined ? stmt.first() : stmt.first(col)),
    all: () => stmt.all(),
    raw: (opts?: unknown) => (stmt.raw as (o?: unknown) => unknown)(opts),
  } as unknown as D1PreparedStatement);
  return {
    prepare: (sql: string) =>
      sql.includes(sqlFragment) ? wrap(env.DB.prepare(sql), ++matched === nth) : env.DB.prepare(sql),
    batch: (stmts: D1PreparedStatement[]) => env.DB.batch(stmts),
    exec: (sql: string) => env.DB.exec(sql),
  } as unknown as D1Database;
}

async function auditCount(action: string, entityId: number): Promise<number> {
  const r = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM audit_logs WHERE action = ? AND entity_id = ? AND actor = ?"
  ).bind(action, entityId, IDENT.email).first<{ n: number }>();
  return r!.n;
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
    env.DB.prepare(
      `INSERT INTO workspaces (id,name,owner_id,channel_type,settings,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`
    ).bind(WS_OTHER, "別人的工作區", "someone-else", "discord", "{}", TS, TS),
    env.DB.prepare(`INSERT INTO users (id,workspace_id,display_name,created_at,updated_at) VALUES (?,?,?,?,?)`).bind(U_OTHER_WS, WS_OTHER, "外人", TS, TS),
    env.DB.prepare(`INSERT INTO users (id,workspace_id,display_name,created_at,updated_at) VALUES (?,?,?,?,?)`).bind(U_C, WS, "小美", TS, TS),
    sub(SUB_A1, U_A), sub(SUB_A2, U_A), sub(SUB_B1, U_B),
    sub(SUB_C1, U_C), sub(SUB_C2, U_C), sub(SUB_C3, U_C),
    pay(P_A1, SUB_A1, PERIOD, "paid", 1),      // declared LINE Pay
    pay(P_A2, SUB_A2, PERIOD, "paid", null),   // no declared channel
    pay(P_B1, SUB_B1, PERIOD, "paid", 1),      // another member, same period
    pay(P_A_OTHER, SUB_A1, "2028-04", "paid", 1), // same member, another period
    pay(P_C1, SUB_C1, PERIOD_C, "paid", 1),    // three rows for the mid-batch failure test
    pay(P_C2, SUB_C2, PERIOD_C, "paid", 1),
    pay(P_C3, SUB_C3, PERIOD_C, "paid", 1),
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

// Last in the file on purpose: this flips P_A1/P_A2 to verified and `it` blocks share
// storage within a file, so the read-only filter tests above must run first.
describe("POST /admin/payments/verify-all", () => {
  it("verifies the member's whole period in one call, each row keeping its declared channel", async () => {
    const res = await call("POST", "/admin/payments/verify-all", { user_id: U_A, period: PERIOD });
    expect(res!.status).toBe(200);
    const b = (await res!.json()) as any;
    expect(b.ok).toBe(true);
    expect(b.verified).toBe(2);
    expect(b.payment_ids.sort()).toEqual([P_A1, P_A2]);
    const rows = await env.DB.prepare(
      "SELECT id, status, verified_channel_tag_id, verified_by FROM payments WHERE id IN (?,?)"
    ).bind(P_A1, P_A2).all<{ id: number; status: string; verified_channel_tag_id: number | null; verified_by: string }>();
    expect(rows.results.every((r) => r.status === "verified")).toBe(true);
    expect(rows.results.every((r) => r.verified_by === IDENT.email)).toBe(true);
    expect(rows.results.find((r) => r.id === P_A1)!.verified_channel_tag_id).toBe(1); // its own declared tag
    expect(rows.results.find((r) => r.id === P_A2)!.verified_channel_tag_id).toBeNull();
  });

  it("audits every payment plus one batch summary on the member", async () => {
    expect(await auditCount("payment.verify", P_A1)).toBe(1);
    expect(await auditCount("payment.verify", P_A2)).toBe(1);
    const batch = await env.DB.prepare(
      "SELECT entity_type, before_json, after_json FROM audit_logs WHERE action = 'payment.verify_all' AND entity_id = ?"
    ).bind(U_A).first<{ entity_type: string; before_json: string | null; after_json: string }>();
    expect(batch!.entity_type).toBe("user");
    expect(JSON.parse(batch!.after_json)).toMatchObject({ period: PERIOD, verified: 2 });
    expect(JSON.parse(batch!.after_json).payment_ids.sort()).toEqual([P_A1, P_A2]);
  });

  it("writes each row's own before/after into its payment.verify audit, like single verify", async () => {
    const row = await env.DB.prepare(
      "SELECT before_json, after_json FROM audit_logs WHERE action = 'payment.verify' AND entity_id = ?"
    ).bind(P_A1).first<{ before_json: string; after_json: string }>();
    expect(JSON.parse(row!.before_json)).toMatchObject({ id: P_A1, status: "paid" });
    expect(JSON.parse(row!.after_json)).toMatchObject({ id: P_A1, status: "verified", verified_channel_tag_id: 1 });
  });

  it("leaves the other member's row for the same period alone", async () => {
    const row = await env.DB.prepare("SELECT status FROM payments WHERE id = ?").bind(P_B1).first<{ status: string }>();
    expect(row?.status).toBe("paid");
  });

  it("leaves the member's other periods alone", async () => {
    const row = await env.DB.prepare("SELECT status FROM payments WHERE id = ?").bind(P_A_OTHER).first<{ status: string }>();
    expect(row?.status).toBe("paid");
  });

  it("is a no-op on a second call", async () => {
    const res = await call("POST", "/admin/payments/verify-all", { user_id: U_A, period: PERIOD });
    expect(res!.status).toBe(200);
    const b = (await res!.json()) as any;
    expect(b.verified).toBe(0);
    expect(b.payment_ids).toEqual([]);
    expect(await auditCount("payment.verify", P_A1)).toBe(1); // no second audit for an already-verified row
  });

  it("400s on a missing user_id or a malformed period", async () => {
    expect((await call("POST", "/admin/payments/verify-all", { period: PERIOD }))!.status).toBe(400);
    expect((await call("POST", "/admin/payments/verify-all", { user_id: 0, period: PERIOD }))!.status).toBe(400);
    expect((await call("POST", "/admin/payments/verify-all", { user_id: "9400", period: PERIOD }))!.status).toBe(400);
    expect((await call("POST", "/admin/payments/verify-all", { user_id: U_A, period: "2028-3" }))!.status).toBe(400);
    expect((await call("POST", "/admin/payments/verify-all", { user_id: U_A }))!.status).toBe(400);
    expect((await call("POST", "/admin/payments/verify-all"))!.status).toBe(400);
  });

  it("404s for an unknown member or one outside the workspace", async () => {
    expect((await call("POST", "/admin/payments/verify-all", { user_id: 999999, period: PERIOD }))!.status).toBe(404);
    expect((await call("POST", "/admin/payments/verify-all", { user_id: U_OTHER_WS, period: PERIOD }))!.status).toBe(404);
  });
});

// #35: the sweep commits row by row, so a hard D1 error mid-batch must neither lose the audit of
// what already committed nor answer with a full-success shape.
describe("POST /admin/payments/verify-all mid-batch hard error", () => {
  it("keeps the committed row's audit and answers with the partial result, not ok", async () => {
    // The sweep's 2nd guarded UPDATE dies: row 1 committed, row 2 never flipped, row 3 unreached.
    const res = await call("POST", "/admin/payments/verify-all", { user_id: U_C, period: PERIOD_C },
      dbFailingOn("UPDATE payments SET status", 2));
    expect(res!.status).toBe(500);
    const b = (await res!.json()) as any;
    expect(b.ok).toBeUndefined();            // never the full-success shape
    expect(b.error).toContain("模擬硬錯誤");  // the underlying failure reaches the admin
    expect(b.verified).toBe(1);
    expect(b.payment_ids).toEqual([P_C1]);

    // The point of the issue: the row that committed still carries its own per-row audit,
    // with the same before/after payload single verify writes.
    expect(await auditCount("payment.verify", P_C1)).toBe(1);
    expect(await auditCount("payment.verify", P_C2)).toBe(0);
    const audit = await env.DB.prepare(
      "SELECT before_json, after_json FROM audit_logs WHERE action = 'payment.verify' AND entity_id = ?"
    ).bind(P_C1).first<{ before_json: string; after_json: string }>();
    expect(JSON.parse(audit!.before_json)).toMatchObject({ id: P_C1, status: "paid" });
    expect(JSON.parse(audit!.after_json)).toMatchObject({ id: P_C1, status: "verified", verified_channel_tag_id: 1 });

    const rows = await env.DB.prepare("SELECT id, status FROM payments WHERE id IN (?,?,?)")
      .bind(P_C1, P_C2, P_C3).all<{ id: number; status: string }>();
    const statusOf = (id: number) => rows.results.find((r) => r.id === id)!.status;
    expect(statusOf(P_C1)).toBe("verified");
    expect(statusOf(P_C2)).toBe("paid");     // its UPDATE is the one that blew up
    expect(statusOf(P_C3)).toBe("paid");     // the sweep stopped before reaching it

    // The batch summary is still written, flagged partial, carrying the same counts as the response.
    const summary = await env.DB.prepare(
      "SELECT after_json FROM audit_logs WHERE action = 'payment.verify_all' AND entity_id = ?"
    ).bind(U_C).first<{ after_json: string }>();
    const after = JSON.parse(summary!.after_json);
    expect(after).toMatchObject({ period: PERIOD_C, verified: 1, partial: true });
    expect(after.payment_ids).toEqual([P_C1]);
    expect(after.error).toContain("模擬硬錯誤");
  });

  it("retries cleanly: the second call sweeps only what was left and re-audits nothing", async () => {
    const res = await call("POST", "/admin/payments/verify-all", { user_id: U_C, period: PERIOD_C });
    expect(res!.status).toBe(200);
    const b = (await res!.json()) as any;
    expect(b.ok).toBe(true);
    expect(b.payment_ids.sort()).toEqual([P_C2, P_C3]);
    expect(await auditCount("payment.verify", P_C1)).toBe(1); // already verified → not swept again
    expect(await auditCount("payment.verify", P_C2)).toBe(1);
  });
});
