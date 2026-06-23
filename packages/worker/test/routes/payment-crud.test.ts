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

describe("DELETE /admin/payments/:id", () => {
  it("hard-deletes any-status payment, cleans token, writes audit", async () => {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO payments (id,workspace_id,subscription_id,period,period_start,period_end,due_date,amount,status,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(9210,WS,SUB,"2027-03","2027-03-01","2027-03-31","2027-03-05",315,"pending","cron",TS,TS),
      env.DB.prepare(`INSERT INTO upload_tokens (token_hash,workspace_id,user_id,period,subscription_id,expires_at,created_at) VALUES (?,?,?,?,?,?,?)`)
        .bind("h-9210",WS,U,"2027-03",SUB,TS,TS),
    ]);
    const res = await call("DELETE", "/admin/payments/9210");
    expect(res!.status).toBe(200);
    const gone = await env.DB.prepare("SELECT id FROM payments WHERE id = ?").bind(9210).first();
    expect(gone).toBeNull();
    const tok = await env.DB.prepare("SELECT id FROM upload_tokens WHERE token_hash = ?").bind("h-9210").first();
    expect(tok).toBeNull();
    const a = await env.DB.prepare("SELECT action FROM audit_logs WHERE entity_type='payment' AND entity_id=9210").first<{action:string}>();
    expect(a?.action).toBe("payment.delete");
  });
  it("404 for a payment outside the workspace", async () => {
    // a payment under a different workspace (9299); wsId()=1 ≠ 9299 → 404 before any cascade.
    await env.DB.prepare(`INSERT INTO workspaces (id,name,owner_id,channel_type,billing_day,settings,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(9299,"O","o","discord",5,"{}",TS,TS).run();
    await env.DB.prepare(`INSERT INTO payments (id,workspace_id,subscription_id,period,period_start,period_end,due_date,amount,status,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(9298,9299,SUB,"2027-04","2027-04-01","2027-04-30","2027-04-05",315,"pending","cron",TS,TS).run();
    const res = await call("DELETE", "/admin/payments/9298");
    expect(res!.status).toBe(404);
  });
  it("keeps a shared screenshot object when another payment still references it", async () => {
    await env.BUCKET.put("shared-9230", "img");
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(9230,WS,U,1,"2027-01-01",5,TS,TS),
      env.DB.prepare(`INSERT INTO payments (id,workspace_id,subscription_id,period,period_start,period_end,due_date,amount,status,source,screenshot_key,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(9231,WS,SUB,"2027-05","2027-05-01","2027-05-31","2027-05-05",315,"paid","user_slash","shared-9230",TS,TS),
      env.DB.prepare(`INSERT INTO payments (id,workspace_id,subscription_id,period,period_start,period_end,due_date,amount,status,source,screenshot_key,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(9232,WS,9230,"2027-05","2027-05-01","2027-05-31","2027-05-05",315,"paid","user_slash","shared-9230",TS,TS),
    ]);
    await call("DELETE", "/admin/payments/9231");
    expect(await env.BUCKET.get("shared-9230")).not.toBeNull(); // 9232 still references it
    await call("DELETE", "/admin/payments/9232");
    expect(await env.BUCKET.get("shared-9230")).toBeNull(); // last reference gone
  });
});

describe("PATCH /admin/users/:id discord_id presence semantics", () => {
  it("omitting discord_id keeps the existing binding", async () => {
    await env.DB.prepare(`INSERT INTO users (id,workspace_id,display_name,discord_id,created_at,updated_at) VALUES (?,?,?,?,?,?)`).bind(9240,WS,"Bound","disc-9240",TS,TS).run();
    const res = await call("PATCH", "/admin/users/9240", { display_name: "Bound2" });
    expect(res!.status).toBe(200);
    const u = await env.DB.prepare("SELECT display_name, discord_id FROM users WHERE id=?").bind(9240).first<{display_name:string;discord_id:string|null}>();
    expect(u?.display_name).toBe("Bound2");
    expect(u?.discord_id).toBe("disc-9240");
  });
  it("explicit empty discord_id unbinds", async () => {
    const res = await call("PATCH", "/admin/users/9240", { discord_id: "" });
    expect(res!.status).toBe(200);
    const u = await env.DB.prepare("SELECT discord_id FROM users WHERE id=?").bind(9240).first<{discord_id:string|null}>();
    expect(u?.discord_id).toBeNull();
  });
  it("createUser stores a blank discord_id as NULL (not empty string)", async () => {
    const res = await call("POST", "/admin/users", { display_name: "Blank", discord_id: "  " });
    expect(res!.status).toBe(201);
    const id = ((await res!.json()) as any).id as number;
    const u = await env.DB.prepare("SELECT discord_id FROM users WHERE id=?").bind(id).first<{discord_id:string|null}>();
    expect(u?.discord_id).toBeNull();
  });
});

// Route tests run on the shared seeded workspace 1 (wsId()===1), which carries the 0002_seed.sql
// baseline roster. Assert RELATIVE behavior (our SUB + dry-run-writes-nothing), not exact totals —
// precise add/remove/reprice/freeze counts live in the isolated core test (billing-reconcile.test.ts).
describe("POST /admin/billing/:period/sync", () => {
  const PER = "2027-09"; // a fresh opened period where our active SUB has no bill yet
  it("dry_run returns diff including our sub and writes nothing", async () => {
    await env.DB.prepare(`INSERT INTO notification_logs (workspace_id,type,period,plan_id,user_id,subscription_id,sent_at) VALUES (?,?,?,?,?,?,?)`).bind(WS,"billing_opened",PER,0,0,0,TS).run();
    const before = (await env.DB.prepare("SELECT COUNT(*) c FROM payments WHERE workspace_id=? AND period=?").bind(WS,PER).first<{c:number}>())?.c ?? 0;
    const res = await call("POST", `/admin/billing/${PER}/sync`, { dry_run: true });
    expect(res!.status).toBe(200);
    const d = await res!.json() as any;
    expect(d.opened).toBe(true);
    expect(d.add.some((a: any) => a.subscription_id === SUB)).toBe(true);
    const after = (await env.DB.prepare("SELECT COUNT(*) c FROM payments WHERE workspace_id=? AND period=?").bind(WS,PER).first<{c:number}>())?.c ?? 0;
    expect(after).toBe(before); // dry run wrote nothing
  });
  it("apply creates the missing bill and returns counts", async () => {
    const res = await call("POST", `/admin/billing/${PER}/sync`, { dry_run: false });
    const r = await res!.json() as any;
    expect(r.ok).toBe(true);
    expect(r.applied.added).toBeGreaterThanOrEqual(1);
    const mine = await env.DB.prepare("SELECT id FROM payments WHERE subscription_id=? AND period=?").bind(SUB,PER).first();
    expect(mine).not.toBeNull();
  });
  it("rejects a malformed period", async () => {
    const res = await call("POST", "/admin/billing/2027-9/sync", { dry_run: true });
    expect(res!.status).toBe(400);
  });
  it("defaults to dry-run (no writes) when the body omits dry_run", async () => {
    const PER2 = "2027-10";
    await env.DB.prepare(`INSERT INTO notification_logs (workspace_id,type,period,plan_id,user_id,subscription_id,sent_at) VALUES (?,?,?,?,?,?,?)`).bind(WS,"billing_opened",PER2,0,0,0,TS).run();
    const res = await call("POST", `/admin/billing/${PER2}/sync`); // no body
    expect(res!.status).toBe(200);
    const d = await res!.json() as any;
    expect(d.opened).toBe(true);
    expect(Array.isArray(d.add)).toBe(true); // preview shape, not an apply result
    const cnt = (await env.DB.prepare("SELECT COUNT(*) c FROM payments WHERE workspace_id=? AND period=?").bind(WS,PER2).first<{c:number}>())?.c ?? 0;
    expect(cnt).toBe(0); // safe default wrote nothing
  });
});

describe("PATCH /admin/users/:id keeps unspecified email/note", () => {
  it("does not null email/note when omitted", async () => {
    await env.DB.prepare(`INSERT INTO users (id,workspace_id,display_name,email,note,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`)
      .bind(9220,WS,"Keep","keep@x.tw","原備註",TS,TS).run();
    const res = await call("PATCH", "/admin/users/9220", { display_name: "Keep2" });
    expect(res!.status).toBe(200);
    const u = await env.DB.prepare("SELECT display_name,email,note FROM users WHERE id=?").bind(9220).first<{display_name:string;email:string|null;note:string|null}>();
    expect(u?.display_name).toBe("Keep2");
    expect(u?.email).toBe("keep@x.tw");
    expect(u?.note).toBe("原備註");
  });
});
