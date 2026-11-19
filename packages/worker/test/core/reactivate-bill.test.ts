import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { ensureReactivatedPeriodPayment } from "../../src/core/billing";
import { importRoster } from "../../src/core/import";
import { periodForBillingDay } from "../../src/core/time";
import { buildAdminRouter } from "../../src/routes/admin";

// A sub brought back to active (後台 edit cancelled/paused → active, or roster import reactivating a
// paused sub) must get the open collection period's bill right away. Before, the bill only appeared
// when the member pressed 繳費, so 催繳 had nothing to find for weeks (field report 2026-10).

const TS = "2026-05-01T00:00:00.000Z";
const WS = 9560, PLAN = 9560, BILLING_DAY = 5;
const U_EDIT = 9560, U_IMPORT = 95601, U_UNOPENED = 95602;
const S_CANCELLED = 9560, S_PAUSED_IMPORT = 95601, S_PAUSED_UNOPENED = 95602, S_ACTIVE = 95603;
const CURRENT = periodForBillingDay(BILLING_DAY);

const router = buildAdminRouter();
const patch = (id: number, body: unknown) =>
  router.handle(new Request(`https://x/admin/subscriptions/${id}`, {
    method: "PATCH", body: JSON.stringify(body), headers: { "content-type": "application/json" },
  }), env, { identity: { email: "owner@example.com" } });
const bills = (subId: number) =>
  env.DB.prepare("SELECT period, status, amount FROM payments WHERE subscription_id = ? ORDER BY period").bind(subId)
    .all<{ period: string; status: string; amount: number }>().then((r) => r.results);
const sub = (id: number, user: number, status: string) =>
  env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`)
    .bind(id, WS, user, PLAN, "2026-01-01", BILLING_DAY, status, TS, TS);

beforeAll(async () => {
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO workspaces (id,name,owner_id,channel_type,billing_day,settings,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(WS, "W", "o", "discord", BILLING_DAY, "{}", TS, TS),
    env.DB.prepare(`INSERT INTO plans (id,workspace_id,name,provider,monthly_amount,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`).bind(PLAN, WS, "ChatGPT", "openai", 315, TS, TS),
    env.DB.prepare(`INSERT INTO users (id,workspace_id,display_name,email,created_at,updated_at) VALUES (?,?,?,?,?,?)`).bind(U_EDIT, WS, "Edit", "edit@x.tw", TS, TS),
    env.DB.prepare(`INSERT INTO users (id,workspace_id,display_name,email,created_at,updated_at) VALUES (?,?,?,?,?,?)`).bind(U_IMPORT, WS, "Import", "import@x.tw", TS, TS),
    env.DB.prepare(`INSERT INTO users (id,workspace_id,display_name,email,created_at,updated_at) VALUES (?,?,?,?,?,?)`).bind(U_UNOPENED, WS, "Unopened", "unopened@x.tw", TS, TS),
    sub(S_CANCELLED, U_EDIT, "cancelled"),
    sub(S_PAUSED_IMPORT, U_IMPORT, "paused"),
    sub(S_PAUSED_UNOPENED, U_UNOPENED, "paused"),
    sub(S_ACTIVE, U_EDIT, "active"),
    env.DB.prepare(`INSERT INTO notification_logs (workspace_id,type,period,event,sent_at) VALUES (?,?,?,?,?)`).bind(WS, "billing_opened", CURRENT, "", TS),
  ]);
});

describe("ensureReactivatedPeriodPayment", () => {
  it("returns null when the collection period is not open yet (發起繳費 will bill it)", async () => {
    const r = await ensureReactivatedPeriodPayment(env.DB, WS, S_PAUSED_UNOPENED, new Date("2099-03-10T00:00:00Z"));
    expect(r).toBeNull();
    expect(await bills(S_PAUSED_UNOPENED)).toEqual([]);
  });
});

describe("後台 edit back to active", () => {
  it("cancelled → active bills the open collection period at once (not the old start month)", async () => {
    const res = await patch(S_CANCELLED, { status: "active" });
    const body = (await res!.json()) as any;
    expect(body.reactivated_bill).toMatchObject({ period: CURRENT, created: true });
    expect(await bills(S_CANCELLED)).toEqual([{ period: CURRENT, status: "pending", amount: 315 }]);
  });

  it("is idempotent: pausing and re-activating does not add a second bill", async () => {
    await patch(S_CANCELLED, { status: "paused" });
    const body = (await (await patch(S_CANCELLED, { status: "active" }))!.json()) as any;
    expect(body.reactivated_bill).toMatchObject({ period: CURRENT, created: false });
    expect((await bills(S_CANCELLED)).length).toBe(1);
  });

  it("an edit that keeps an active sub active bills nothing", async () => {
    const body = (await (await patch(S_ACTIVE, { status: "active", billing_day: 5 }))!.json()) as any;
    expect(body.reactivated_bill).toBeNull();
    expect(await bills(S_ACTIVE)).toEqual([]);
  });
});

describe("roster import reactivation", () => {
  it("a reactivated paused sub gets the open collection period's bill", async () => {
    await importRoster(env, WS, [{ name: "Import", email: "import@x.tw", plans: ["ChatGPT"], plansOff: [] }], { startDate: `${CURRENT}-01`, dryRun: false });
    expect(await bills(S_PAUSED_IMPORT)).toEqual([{ period: CURRENT, status: "pending", amount: 315 }]);
  });
});
