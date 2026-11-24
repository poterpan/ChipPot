import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { buildAdminRouter } from "../../src/routes/admin";

// 附卡 (#58) fields on the admin subscription API. Operates on the seeded workspace 1 (plan 1).
const router = buildAdminRouter();
function call(method: string, path: string, body?: unknown) {
  return router.handle(new Request(`https://x${path}`, {
    method, body: JSON.stringify(body), headers: { "content-type": "application/json" },
  }), env, { identity: { email: "owner@example.com" } });
}
const row = (id: number) =>
  env.DB.prepare("SELECT account_label, account_email, status FROM subscriptions WHERE id = ?").bind(id).first<{ account_label: string | null; account_email: string | null; status: string }>();

describe("admin subscription 附卡 fields", () => {
  it("lets one member hold the same plan twice, the second as a labelled 附卡", async () => {
    const u = await call("POST", "/admin/users", { display_name: "Payer58" });
    const uid = ((await u!.json()) as any).id as number;
    const a = await call("POST", "/admin/subscriptions", { user_id: uid, plan_id: 1, start_date: "2031-01-01" });
    const b = await call("POST", "/admin/subscriptions", { user_id: uid, plan_id: 1, start_date: "2031-01-01", account_label: " 帳號 2 ", account_email: "second@x.tw" });
    expect(a!.status).toBe(201);
    expect(b!.status).toBe(201);
    const subA = ((await a!.json()) as any).id as number, subB = ((await b!.json()) as any).id as number;
    expect(await row(subA)).toMatchObject({ account_label: null, account_email: null });
    expect(await row(subB)).toMatchObject({ account_label: "帳號 2", account_email: "second@x.tw" });
  });

  it("PATCH sets, keeps (field omitted) and clears (blank) the 附卡 fields", async () => {
    const u = await call("POST", "/admin/users", { display_name: "Payer58b" });
    const uid = ((await u!.json()) as any).id as number;
    const s = await call("POST", "/admin/subscriptions", { user_id: uid, plan_id: 1, start_date: "2031-02-01" });
    const id = ((await s!.json()) as any).id as number;

    await call("PATCH", `/admin/subscriptions/${id}`, { account_label: "帳號 3", account_email: "third@x.tw" });
    expect(await row(id)).toMatchObject({ account_label: "帳號 3", account_email: "third@x.tw" });

    await call("PATCH", `/admin/subscriptions/${id}`, { status: "paused" });
    expect(await row(id)).toMatchObject({ account_label: "帳號 3", account_email: "third@x.tw", status: "paused" });

    await call("PATCH", `/admin/subscriptions/${id}`, { account_label: "  ", account_email: "" });
    expect(await row(id)).toMatchObject({ account_label: null, account_email: null });
  });

  it("rejects an email without a label (it would hide the sub from import and double-bill)", async () => {
    const u = await call("POST", "/admin/users", { display_name: "Payer58c" });
    const uid = ((await u!.json()) as any).id as number;
    const bad = await call("POST", "/admin/subscriptions", { user_id: uid, plan_id: 1, start_date: "2031-03-01", account_email: "x@x.tw" });
    expect(bad!.status).toBe(400);

    const s = await call("POST", "/admin/subscriptions", { user_id: uid, plan_id: 1, start_date: "2031-03-01", account_label: "帳號 2", account_email: "x@x.tw" });
    const id = ((await s!.json()) as any).id as number;
    // Clearing only the label leaves the stored email behind → must be refused, row unchanged.
    expect((await call("PATCH", `/admin/subscriptions/${id}`, { account_label: "" }))!.status).toBe(400);
    expect(await row(id)).toMatchObject({ account_label: "帳號 2", account_email: "x@x.tw" });
  });

  it("subscription list returns the labelled plan name (manual-payment picker relies on it)", async () => {
    const r = await call("GET", "/admin/subscriptions");
    const subs = ((await r!.json()) as any).subscriptions as { plan_name: string; account_label: string | null }[];
    expect(subs.some((x) => x.account_label === "帳號 2" && x.plan_name.endsWith("（帳號 2）"))).toBe(true);
  });

  it("PATCH with a non-object JSON body is a no-op, not a 500", async () => {
    const r = await call("PATCH", "/admin/subscriptions/1", 42);
    expect(r!.status).toBe(200);
  });
});
