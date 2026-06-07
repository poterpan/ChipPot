import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { buildAdminRouter } from "../../src/routes/admin";
import { getPayment } from "../../src/core/payments";
import { hashToken, findValidUploadToken } from "../../src/core/tokens";
import { nowUtcIso } from "../../src/core/time";
import { putObject, getObject } from "../../src/core/storage";

const router = buildAdminRouter();
const IDENT = { email: "owner@example.com" };

function call(method: string, path: string, body?: unknown) {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { "content-type": "application/json" };
  }
  return router.handle(new Request(`https://x${path}`, init), env, { identity: IDENT });
}

async function auditCount(action: string, entityId: number): Promise<number> {
  const r = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM audit_logs WHERE action = ? AND entity_id = ? AND actor = ?"
  ).bind(action, entityId, IDENT.email).first<{ n: number }>();
  return r!.n;
}

// Operates on the seeded workspace 1 (plan 1 = ChatGPT 315, channel_tag 1 = LINE Pay).
describe("admin API", () => {
  it("creates a user, subscription (with first payment), and audits both", async () => {
    const uRes = await call("POST", "/admin/users", { display_name: "Bob", discord_id: "d-bob" });
    expect(uRes!.status).toBe(201);
    const userId = ((await uRes!.json()) as any).id as number;
    expect(await auditCount("user.create", userId)).toBe(1);

    const sRes = await call("POST", "/admin/subscriptions", { user_id: userId, plan_id: 1, start_date: "2026-06-10" });
    expect(sRes!.status).toBe(201);
    const sBody = (await sRes!.json()) as any;
    const subId = sBody.id as number;
    const firstPaymentId = sBody.first_payment_id as number;
    expect(await auditCount("subscription.create", subId)).toBe(1);

    const p = await getPayment(env.DB, firstPaymentId);
    expect(p?.status).toBe("pending");
    expect(p?.period).toBe("2026-06");
    expect(p?.amount).toBe(315);
    expect(p?.due_date).toBe("2026-06-05");

    // override amount, then verify
    const oRes = await call("POST", `/admin/payments/${firstPaymentId}/amount`, { amount: 300 });
    expect(oRes!.status).toBe(200);
    expect((await getPayment(env.DB, firstPaymentId))?.amount).toBe(300);
    expect(await auditCount("amount.override", firstPaymentId)).toBe(1);

    const vRes = await call("POST", `/admin/payments/${firstPaymentId}/verify`, { verified_channel_tag_id: 1 });
    expect(vRes!.status).toBe(200);
    const vp = await getPayment(env.DB, firstPaymentId);
    expect(vp?.status).toBe("verified");
    expect(vp?.verified_by).toBe(IDENT.email);
    expect(vp?.verified_channel_tag_id).toBe(1);
    expect(await auditCount("payment.verify", firstPaymentId)).toBe(1);

    // reconcile sees the verified payment
    const rRes = await call("GET", "/admin/reconcile?period=2026-06");
    const recon = (await rRes!.json()) as any;
    expect(recon.status_counts.verified).toBeGreaterThanOrEqual(1);
    expect(recon.verified_amount).toBeGreaterThanOrEqual(300);

    // one-time upload link
    const lRes = await call("POST", "/admin/upload-link", { user_id: userId, period: "2026-07", subscription_id: subId });
    expect(lRes!.status).toBe(201);
    const link = (await lRes!.json()) as any;
    // url is a full absolute link built from WEB_ORIGIN, ending in the token path (no hardcoded domain).
    expect(link.url).toMatch(/^https?:\/\/.+\/u\/.+$/);
    expect(link.url.endsWith(link.path)).toBe(true);
    const tok = await findValidUploadToken(env.DB, await hashToken(link.token), nowUtcIso());
    expect(tok?.user_id).toBe(userId);
    expect(tok?.period).toBe("2026-07");

    // manual verified payment (admin_manual)
    const mRes = await call("POST", "/admin/payments/manual", { subscription_id: subId, period: "2026-08", status: "verified", verified_channel_tag_id: 1 });
    expect(mRes!.status).toBe(201);
    const mId = ((await mRes!.json()) as any).id as number;
    const mp = await getPayment(env.DB, mId);
    expect(mp?.status).toBe("verified");
    expect(mp?.source).toBe("admin_manual");
    expect(await auditCount("payment.manual", mId)).toBe(1);
  });

  it("upload-link 500s when WEB_ORIGIN is not configured", async () => {
    const u = await call("POST", "/admin/users", { display_name: "NoOrigin" });
    const uid = ((await u!.json()) as any).id as number;
    const prev = (env as any).WEB_ORIGIN;
    delete (env as any).WEB_ORIGIN;
    const res = await call("POST", "/admin/upload-link", { user_id: uid, period: "2027-05" });
    (env as any).WEB_ORIGIN = prev;
    expect(res!.status).toBe(500);
  });

  it("creates/rebuilds the persistent Discord payment message", async () => {
    await call("PATCH", "/admin/workspace", { settings: { discord_billing_channel_id: "chan-1" } });
    // Supply the bot token locally (CI has no .dev.vars), then restore it — the later
    // billing/initiate test doesn't stub fetch, so it must keep its no-real-send behavior.
    const prevToken = (env as any).DISCORD_BOT_TOKEN;
    (env as any).DISCORD_BOT_TOKEN = "test-bot-token";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ id: "msg-123" }), { status: 200 })));
    const res = await call("POST", "/admin/discord/payment-message");
    vi.unstubAllGlobals();
    (env as any).DISCORD_BOT_TOKEN = prevToken;
    expect(res!.status).toBe(200);
    expect(((await res!.json()) as any).message_id).toBe("msg-123");
  });

  it("reads and updates workspace settings", async () => {
    const g = await call("GET", "/admin/workspace");
    const ws = ((await g!.json()) as any).workspace;
    expect(ws.settings.timezone).toBe("Asia/Taipei");

    const u = await call("PATCH", "/admin/workspace", { billing_day: 7, settings: { overdue_days: 5 } });
    expect(u!.status).toBe(200);
    const g2 = await call("GET", "/admin/workspace");
    const ws2 = ((await g2!.json()) as any).workspace;
    expect(ws2.billing_day).toBe(7);
    expect(ws2.settings.overdue_days).toBe(5);
    expect(ws2.settings.timezone).toBe("Asia/Taipei"); // preserved
    // restore
    await call("PATCH", "/admin/workspace", { billing_day: 5, settings: { overdue_days: 3 } });
  });

  it("deletes a proof (R2 + key) and audits it", async () => {
    // seed a payment with a screenshot directly
    const key = "1/2026-09/1/admintest.png";
    await putObject(env.BUCKET, key, new Uint8Array([1, 2, 3]), "image/png");
    const ins = await env.DB.prepare(
      `INSERT INTO payments (workspace_id,subscription_id,period,period_start,period_end,due_date,amount,status,has_proof,screenshot_key,source,created_at,updated_at)
       SELECT 1, s.id, '2026-09', '2026-09-01','2026-09-30','2026-09-05', 315, 'paid', 1, ?, 'user_web', ?, ?
       FROM subscriptions s WHERE s.workspace_id = 1 ORDER BY s.id LIMIT 1`
    ).bind(key, nowUtcIso(), nowUtcIso()).run();
    const pid = ins.meta.last_row_id as number;

    const res = await call("POST", `/admin/payments/${pid}/delete-proof`);
    expect(res!.status).toBe(200);
    const p = await getPayment(env.DB, pid);
    expect(p?.screenshot_key).toBeNull();
    expect(p?.proof_deleted_at).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(await getObject(env.BUCKET, key)).toBeNull();
    expect(await auditCount("proof.delete", pid)).toBe(1);
  });

  it("validates manual payment period/amount/tag", async () => {
    const u = await call("POST", "/admin/users", { display_name: "Val" });
    const uid = ((await u!.json()) as any).id as number;
    const s = await call("POST", "/admin/subscriptions", { user_id: uid, plan_id: 1, start_date: "2027-01-01" });
    const sid = ((await s!.json()) as any).id as number;
    expect((await call("POST", "/admin/payments/manual", { subscription_id: sid, period: "2027-13" }))!.status).toBe(400);
    expect((await call("POST", "/admin/payments/manual", { subscription_id: sid, period: "2027-02", amount: -5 }))!.status).toBe(400);
    expect((await call("POST", "/admin/payments/manual", { subscription_id: sid, period: "2027-03", verified_channel_tag_id: 999999 }))!.status).toBe(400);
  });

  it("rejects an invalid status transition with 409", async () => {
    const u = await call("POST", "/admin/users", { display_name: "Carol" });
    const uid = ((await u!.json()) as any).id as number;
    const s = await call("POST", "/admin/subscriptions", { user_id: uid, plan_id: 1, start_date: "2026-11-01" });
    const sid = ((await s!.json()) as any).id as number;
    // manual upsert flips the first payment to verified (terminal)
    const m = await call("POST", "/admin/payments/manual", { subscription_id: sid, period: "2026-11", status: "verified" });
    const id = ((await m!.json()) as any).id as number;
    const res = await call("POST", `/admin/payments/${id}/reject`, { rejected_reason: "x" });
    expect(res!.status).toBe(409);
  });
});

describe("admin notifications", () => {
  it("reports status, resends (force), and resets", async () => {
    await call("PATCH", "/admin/workspace", { settings: { discord_billing_channel_id: "chan-1" } });
    const u = await call("POST", "/admin/users", { display_name: "Notif", discord_id: "d-notif" });
    const uid = ((await u!.json()) as any).id as number;
    const s = await call("POST", "/admin/subscriptions", { user_id: uid, plan_id: 1, start_date: "2028-03-01" });
    expect(s!.status).toBe(201);

    let st = (await (await call("GET", "/admin/notifications?period=2028-03"))!.json()) as any;
    expect(st.billing_opened).toBeNull();
    expect(st.overdue).toBeNull();

    const prevToken = (env as any).DISCORD_BOT_TOKEN;
    (env as any).DISCORD_BOT_TOKEN = "test-bot-token";
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
    const r = await call("POST", "/admin/notifications/resend", { type: "overdue", period: "2028-03" });
    vi.unstubAllGlobals();
    (env as any).DISCORD_BOT_TOKEN = prevToken;
    expect(r!.status).toBe(200);
    expect(((await r!.json()) as any).count).toBeGreaterThanOrEqual(1);
    st = (await (await call("GET", "/admin/notifications?period=2028-03"))!.json()) as any;
    expect(st.overdue?.sent_at).toBeTruthy();

    const rs = await call("POST", "/admin/notifications/reset", { type: "overdue", period: "2028-03" });
    expect(((await rs!.json()) as any).deleted).toBeGreaterThanOrEqual(1);
    st = (await (await call("GET", "/admin/notifications?period=2028-03"))!.json()) as any;
    expect(st.overdue).toBeNull();
  });

  it("validates type and period (incl. non-string period)", async () => {
    expect((await call("POST", "/admin/notifications/resend", { type: "bogus", period: "2028-03" }))!.status).toBe(400);
    expect((await call("POST", "/admin/notifications/reset", { type: "overdue", period: "bad" }))!.status).toBe(400);
    expect((await call("POST", "/admin/notifications/reset", { type: "overdue", period: ["2028-03"] }))!.status).toBe(400);
  });
});

describe("admin discord slash registration", () => {
  it("registers the three guild commands via the Discord API", async () => {
    // guild id lives in workspace settings; bot token is a runtime secret.
    await call("PATCH", "/admin/workspace", { settings: { discord_guild_id: "guild-777" } });
    const prevToken = (env as any).DISCORD_BOT_TOKEN;
    (env as any).DISCORD_BOT_TOKEN = "test-bot-token";
    let captured: { url: string; body: any } | null = null;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: any) => {
      captured = { url, body: JSON.parse(init.body) };
      return new Response("[]", { status: 200 });
    }));
    const res = await call("POST", "/admin/discord/register-commands");
    vi.unstubAllGlobals();
    (env as any).DISCORD_BOT_TOKEN = prevToken;

    expect(res!.status).toBe(200);
    expect(((await res!.json()) as any).registered).toBe(3);
    expect(captured!.url).toContain("/guilds/guild-777/commands");
    const names = captured!.body.map((c: any) => c.name);
    expect(names).toHaveLength(3);
    expect(new Set(names)).toEqual(new Set(["繳費", "發起繳費", "綁定"])); // order-independent
  });

  it("400s when the bot token is not configured", async () => {
    await call("PATCH", "/admin/workspace", { settings: { discord_guild_id: "guild-777" } });
    const prevToken = (env as any).DISCORD_BOT_TOKEN;
    delete (env as any).DISCORD_BOT_TOKEN;
    const res = await call("POST", "/admin/discord/register-commands");
    (env as any).DISCORD_BOT_TOKEN = prevToken;
    expect(res!.status).toBe(400);
  });
});

describe("admin billing/initiate + declared channel", () => {
  it("POST /admin/billing/initiate updates plan price + pending amounts", async () => {
    const pRes = await call("POST", "/admin/plans", { name: "InitPlan", provider: "openai", monthly_amount: 500 });
    const planId = ((await pRes!.json()) as any).id as number;
    const uRes = await call("POST", "/admin/users", { display_name: "Initer" });
    const uid = ((await uRes!.json()) as any).id as number;
    const sRes = await call("POST", "/admin/subscriptions", { user_id: uid, plan_id: planId, start_date: "2027-09-01" });
    const sid = ((await sRes!.json()) as any).id as number;

    const res = await call("POST", "/admin/billing/initiate", { period: "2027-09", amounts: [{ plan_id: planId, amount: 800 }] });
    expect(res!.status).toBe(200);
    expect(((await res!.json()) as any).updated_payments).toBeGreaterThanOrEqual(1);

    const plan = await env.DB.prepare("SELECT monthly_amount FROM plans WHERE id=?").bind(planId).first<{ monthly_amount: number }>();
    expect(plan?.monthly_amount).toBe(800);
    const pay = await env.DB.prepare("SELECT amount FROM payments WHERE subscription_id=? AND period='2027-09'").bind(sid).first<{ amount: number }>();
    expect(pay?.amount).toBe(800);
  });

  it("billing/initiate validates the period and amounts", async () => {
    expect((await call("POST", "/admin/billing/initiate", { period: "2027-13", amounts: [] }))!.status).toBe(400);
    expect((await call("POST", "/admin/billing/initiate", { period: "2027-09" }))!.status).toBe(400);
    expect((await call("POST", "/admin/billing/initiate", { period: "2027-09", amounts: [null] }))!.status).toBe(400);
    expect((await call("POST", "/admin/billing/initiate", { period: "2027-09", amounts: [{ plan_id: 1, amount: -1 }] }))!.status).toBe(400);
  });

  it("imports a CSV (JSON body) and returns a summary", async () => {
    const csv = "姓名,帳號,ChatGPT,Claude Standard,Claude Premium\nNewMember,newmember@x.tw,TRUE,FALSE,FALSE";
    const res = await call("POST", "/admin/members/import", { csv, start_date: "2027-11-01" });
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as any;
    expect(body.summary).toMatchObject({ usersCreated: 1, subsCreated: 1 });
    const u = await env.DB.prepare("SELECT id FROM users WHERE email='newmember@x.tw'").first<{ id: number }>();
    expect(u).not.toBeNull();
  });

  it("rejects a missing csv, a non-string csv, and a bad start_date", async () => {
    expect((await call("POST", "/admin/members/import", {}))!.status).toBe(400);
    expect((await call("POST", "/admin/members/import", { csv: 123 }))!.status).toBe(400);
    expect((await call("POST", "/admin/members/import", { csv: "姓名,帳號\nA,a@x.tw", start_date: "bad" }))!.status).toBe(400);
  });

  it("treats an empty start_date as the current month (no 400)", async () => {
    const res = await call("POST", "/admin/members/import", { csv: "姓名,帳號,ChatGPT\nEmptyStart,emptystart@x.tw,FALSE", start_date: "" });
    expect(res!.status).toBe(200);
  });

  it("PATCH /admin/users rejects a discord_id already bound to another member", async () => {
    const a = await call("POST", "/admin/users", { display_name: "Conflicter", discord_id: "dup-disc" });
    expect(a!.status).toBe(201);
    const b = await call("POST", "/admin/users", { display_name: "Other" });
    const otherId = ((await b!.json()) as any).id as number;
    const res = await call("PATCH", `/admin/users/${otherId}`, { discord_id: "dup-disc" });
    expect(res!.status).toBe(400);
  });

  it("orders the list with paid (review queue) before pending", async () => {
    const u = await call("POST", "/admin/users", { display_name: "Order" });
    const uid = ((await u!.json()) as any).id as number;
    const sA = await call("POST", "/admin/subscriptions", { user_id: uid, plan_id: 1, start_date: "2029-01-01" });
    await call("POST", "/admin/subscriptions", { user_id: uid, plan_id: 1, start_date: "2029-01-01" });
    const sAid = ((await sA!.json()) as any).id as number;
    await call("POST", "/admin/payments/manual", { subscription_id: sAid, period: "2029-01", status: "paid" });
    const list = await call("GET", "/admin/payments?period=2029-01");
    const ps = ((await list!.json()) as any).payments;
    expect(ps.length).toBe(2);
    expect(ps[0].status).toBe("paid");
    expect(ps[1].status).toBe("pending");
  });

  it("verify pre-fills verified_channel_tag_id from declared; list shows declared name", async () => {
    const uRes = await call("POST", "/admin/users", { display_name: "Declarer" });
    const uid = ((await uRes!.json()) as any).id as number;
    const sRes = await call("POST", "/admin/subscriptions", { user_id: uid, plan_id: 1, start_date: "2027-10-01" });
    const sid = ((await sRes!.json()) as any).id as number;
    await env.DB.prepare("UPDATE payments SET status='paid', declared_channel_tag_id=1, paid_at=?, updated_at=? WHERE subscription_id=? AND period='2027-10'")
      .bind(nowUtcIso(), nowUtcIso(), sid).run();
    const pid = (await env.DB.prepare("SELECT id FROM payments WHERE subscription_id=? AND period='2027-10'").bind(sid).first<{ id: number }>())!.id;

    const v = await call("POST", `/admin/payments/${pid}/verify`, {});
    expect(v!.status).toBe(200);
    expect(((await v!.json()) as any).payment.verified_channel_tag_id).toBe(1);

    const list = await call("GET", "/admin/payments?period=2027-10");
    const payments = ((await list!.json()) as any).payments;
    expect(payments.find((p: any) => p.id === pid).declared_channel_tag_name).toBe("LINE Pay");
  });

  it("PATCH /admin/plans/:id can update the provider", async () => {
    const pRes = await call("POST", "/admin/plans", { name: "GemPlan", provider: "openai", monthly_amount: 400 });
    const planId = ((await pRes!.json()) as any).id as number;
    const up = await call("PATCH", `/admin/plans/${planId}`, { provider: "gemini" });
    expect(up!.status).toBe(200);
    const row = await env.DB.prepare("SELECT provider, monthly_amount FROM plans WHERE id = ?").bind(planId).first<{ provider: string; monthly_amount: number }>();
    expect(row?.provider).toBe("gemini");
    expect(row?.monthly_amount).toBe(400); // untouched fields preserved
  });
});
