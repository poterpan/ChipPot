import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { ensureFirstPayment, ensurePeriodPayment, reconcilePeriodBills, retractPeriodBilling } from "../../src/core/billing";
import { claimNotification } from "../../src/core/notify";

// Fresh id band for this file: workspace/plan 9700, users/subs 970xx, proof keys "proof-9700*".
// (Bands 9xxx up to 9599 and 90xxx/93xxx/94xxx are taken by the other suites.)
const TS = "2026-05-01T00:00:00.000Z";
const WS = 9700, PLAN = 9700;
const P = "2027-11";        // the opened period we retract
const P_NEXT = "2027-12";   // a neighbouring opened period that must survive untouched
const U = 97001;
const S_PEND = 97001, S_REJ = 97002, S_PAID = 97003, S_VER = 97004, S_STALE = 97005;
const WS_OTHER = 9701;      // notification_logs.workspace_id has no FK — the id alone pins the scoping

beforeAll(async () => {
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO workspaces (id,name,owner_id,channel_type,billing_day,settings,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(WS,"W","o","discord",5,"{}",TS,TS),
    env.DB.prepare(`INSERT INTO plans (id,workspace_id,name,provider,monthly_amount,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`).bind(PLAN,WS,"GPT","openai",320,TS,TS),
    env.DB.prepare(`INSERT INTO users (id,workspace_id,display_name,discord_id,created_at,updated_at) VALUES (?,?,?,?,?,?)`).bind(U,WS,"成員","disc-9700",TS,TS),
    env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`).bind(S_PEND,WS,U,PLAN,"2027-01-01",5,"active",TS,TS),
    env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`).bind(S_REJ,WS,U,PLAN,"2027-01-01",5,"active",TS,TS),
    env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`).bind(S_PAID,WS,U,PLAN,"2027-01-01",5,"active",TS,TS),
    env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`).bind(S_VER,WS,U,PLAN,"2027-01-01",5,"active",TS,TS),
    // cancelled sub with a pending bill: retract drops it too (unlike reconcile, roster status is irrelevant)
    env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`).bind(S_STALE,WS,U,PLAN,"2027-01-01",5,"cancelled",TS,TS),
    env.DB.prepare(`INSERT INTO notification_logs (workspace_id,type,period,plan_id,user_id,subscription_id,sent_at) VALUES (?,?,?,?,?,?,?)`).bind(WS,"billing_opened",P,0,0,0,TS),
    env.DB.prepare(`INSERT INTO notification_logs (workspace_id,type,period,plan_id,user_id,subscription_id,sent_at) VALUES (?,?,?,?,?,?,?)`).bind(WS,"billing_opened",P_NEXT,0,0,0,TS),
    env.DB.prepare(`INSERT INTO payments (workspace_id,subscription_id,period,period_start,period_end,due_date,amount,status,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).bind(WS,S_PEND,P,`${P}-01`,`${P}-30`,`${P}-05`,320,"pending","cron",TS,TS),
    // rejected bill carrying a proof that only it references → orphan, must be swept from R2
    env.DB.prepare(`INSERT INTO payments (workspace_id,subscription_id,period,period_start,period_end,due_date,amount,status,source,screenshot_key,has_proof,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(WS,S_REJ,P,`${P}-01`,`${P}-30`,`${P}-05`,320,"rejected","user_slash","proof-9700-orphan",1,TS,TS),
    // paid bill sharing a proof key with the verified one → still referenced after the retract, must survive
    env.DB.prepare(`INSERT INTO payments (workspace_id,subscription_id,period,period_start,period_end,due_date,amount,status,source,screenshot_key,has_proof,paid_at,payment_note,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(WS,S_PAID,P,`${P}-01`,`${P}-30`,`${P}-05`,315,"paid","user_web","proof-9700-keep",1,TS,"轉帳末五碼 12345",TS,TS),
    env.DB.prepare(`INSERT INTO payments (workspace_id,subscription_id,period,period_start,period_end,due_date,amount,status,source,screenshot_key,has_proof,verified_by,verified_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(WS,S_VER,P,`${P}-01`,`${P}-30`,`${P}-05`,315,"verified","admin_manual","proof-9700-keep",1,"owner@example.com",TS,TS,TS),
    env.DB.prepare(`INSERT INTO payments (workspace_id,subscription_id,period,period_start,period_end,due_date,amount,status,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).bind(WS,S_STALE,P,`${P}-01`,`${P}-30`,`${P}-05`,320,"pending","cron",TS,TS),
    // next period's pending bill: proves the retract is scoped to ONE period
    env.DB.prepare(`INSERT INTO payments (workspace_id,subscription_id,period,period_start,period_end,due_date,amount,status,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).bind(WS,S_PEND,P_NEXT,`${P_NEXT}-01`,`${P_NEXT}-31`,`${P_NEXT}-05`,320,"pending","cron",TS,TS),
    env.DB.prepare(`INSERT INTO upload_tokens (token_hash,workspace_id,user_id,period,subscription_id,expires_at,created_at) VALUES (?,?,?,?,?,?,?)`).bind("h-9700-pend",WS,U,P,S_PEND,TS,TS),
    env.DB.prepare(`INSERT INTO upload_tokens (token_hash,workspace_id,user_id,period,subscription_id,expires_at,created_at) VALUES (?,?,?,?,?,?,?)`).bind("h-9700-paid",WS,U,P,S_PAID,TS,TS),
    // NULL subscription_id — what the admin 產生上傳連結 flow actually mints (createUploadLink passes
    // subscription_id only if the caller sent one, and the admin UI never does). A period-wide token
    // must not outlive the period it can settle.
    env.DB.prepare(`INSERT INTO upload_tokens (token_hash,workspace_id,user_id,period,subscription_id,expires_at,created_at) VALUES (?,?,?,?,?,?,?)`).bind("h-9700-null",WS,U,P,null,TS,TS),
    env.DB.prepare(`INSERT INTO upload_tokens (token_hash,workspace_id,user_id,period,subscription_id,expires_at,created_at) VALUES (?,?,?,?,?,?,?)`).bind("h-9700-next-null",WS,U,P_NEXT,null,TS,TS),
    // an overdue reminder already fired for the mis-opened period; its dedup slot must be released
    // on retract, or a later re-open could never remind anyone again
    env.DB.prepare(`INSERT INTO notification_logs (workspace_id,type,period,plan_id,user_id,subscription_id,sent_at) VALUES (?,?,?,?,?,?,?)`).bind(WS,"overdue",P,0,0,0,TS),
    // #48: the cron also leaves per-day slots (event = business date); retract must clear those too,
    // not just the '' slot — a re-open must restart reminders from clean.
    env.DB.prepare(`INSERT INTO notification_logs (workspace_id,type,period,plan_id,user_id,subscription_id,event,sent_at) VALUES (?,?,?,?,?,?,?,?)`).bind(WS,"overdue",P,0,0,0,"2027-11-05",TS),
    // scoping pins: another period of the same workspace, and the same period of another workspace
    env.DB.prepare(`INSERT INTO notification_logs (workspace_id,type,period,plan_id,user_id,subscription_id,sent_at) VALUES (?,?,?,?,?,?,?)`).bind(WS,"overdue",P_NEXT,0,0,0,TS),
    env.DB.prepare(`INSERT INTO notification_logs (workspace_id,type,period,plan_id,user_id,subscription_id,sent_at) VALUES (?,?,?,?,?,?,?)`).bind(WS_OTHER,"overdue",P,0,0,0,TS),
  ]);
  await env.BUCKET.put("proof-9700-orphan", "img");
  await env.BUCKET.put("proof-9700-keep", "img");
});

const countPayments = async (period: string) =>
  (await env.DB.prepare("SELECT COUNT(*) c FROM payments WHERE workspace_id=? AND period=?").bind(WS, period).first<{ c: number }>())!.c;
const countOpenedLogs = async (period: string) =>
  (await env.DB.prepare("SELECT COUNT(*) c FROM notification_logs WHERE workspace_id=? AND type='billing_opened' AND period=?").bind(WS, period).first<{ c: number }>())!.c;
const countOverdueLogs = async (workspace: number, period: string) =>
  (await env.DB.prepare("SELECT COUNT(*) c FROM notification_logs WHERE workspace_id=? AND type='overdue' AND period=?").bind(workspace, period).first<{ c: number }>())!.c;

describe("retractPeriodBilling", () => {
  it("is a no-op for a period that was never opened", async () => {
    const r = await retractPeriodBilling(env, WS, "2099-01", { dryRun: false });
    expect(r.opened).toBe(false);
    expect(r.removed).toEqual([]);
    expect(r.frozen_count).toBe(0);
  });

  it("dryRun lists pending/rejected as removed, counts paid/verified frozen, and writes nothing", async () => {
    const r = await retractPeriodBilling(env, WS, P, { dryRun: true });
    expect(r.opened).toBe(true);
    expect(new Set(r.removed.map((x) => x.subscription_id))).toEqual(new Set([S_PEND, S_REJ, S_STALE]));
    expect(r.frozen_count).toBe(2);
    expect(r.removed.every((x) => x.user_name === "成員" && x.plan_name === "GPT")).toBe(true);

    expect(await countPayments(P)).toBe(5);
    expect(await countOpenedLogs(P)).toBe(1);
    const tokens = (await env.DB.prepare("SELECT COUNT(*) c FROM upload_tokens WHERE workspace_id=? AND period=?").bind(WS, P).first<{ c: number }>())!.c;
    expect(tokens).toBe(3);
    expect(await env.BUCKET.get("proof-9700-orphan")).not.toBeNull();
    expect(await countOverdueLogs(WS, P)).toBe(2); // '' slot + one dated (per-day) slot, both untouched on dry run
  });

  it("apply deletes pending/rejected + the orphaned proof, keeps paid/verified whole, clears the marker", async () => {
    const r = await retractPeriodBilling(env, WS, P, { dryRun: false });
    expect(r.opened).toBe(true);
    expect(r.removed).toHaveLength(3);
    expect(r.frozen_count).toBe(2);
    // applied = what the batch really did, read back from each statement's meta.changes
    expect(r.applied).toMatchObject({ removed: 3, frozen: 2, marker_cleared: true });

    const rows = (await env.DB.prepare("SELECT subscription_id sid, status, amount, screenshot_key, has_proof, source, payment_note, verified_by FROM payments WHERE workspace_id=? AND period=?")
      .bind(WS, P).all<{ sid: number; status: string; amount: number; screenshot_key: string | null; has_proof: number; source: string; payment_note: string | null; verified_by: string | null }>()).results;
    const bySub = new Map(rows.map((x) => [x.sid, x]));
    expect(rows).toHaveLength(2);
    expect(bySub.has(S_PEND)).toBe(false);
    expect(bySub.has(S_REJ)).toBe(false);
    expect(bySub.has(S_STALE)).toBe(false);
    // frozen rows survive with every field intact (a retract must never rewrite settled money)
    expect(bySub.get(S_PAID)).toMatchObject({ status: "paid", amount: 315, screenshot_key: "proof-9700-keep", has_proof: 1, source: "user_web", payment_note: "轉帳末五碼 12345" });
    expect(bySub.get(S_VER)).toMatchObject({ status: "verified", amount: 315, verified_by: "owner@example.com" });

    expect(await env.BUCKET.get("proof-9700-orphan")).toBeNull();  // last reference gone → swept
    expect(await env.BUCKET.get("proof-9700-keep")).not.toBeNull(); // still referenced by the frozen rows
    // Only a FROZEN bill's token may still reference the retracted period: the pending sub's token and
    // the period-wide (NULL subscription) token are both gone, so no live link can settle this period.
    const tok = await env.DB.prepare("SELECT token_hash FROM upload_tokens WHERE workspace_id=? AND period=?").bind(WS, P).all<{ token_hash: string }>();
    expect(tok.results.map((t) => t.token_hash)).toEqual(["h-9700-paid"]);
    // ...while another period's period-wide token is untouched
    const tokNext = await env.DB.prepare("SELECT token_hash FROM upload_tokens WHERE workspace_id=? AND period=?").bind(WS, P_NEXT).all<{ token_hash: string }>();
    expect(tokNext.results.map((t) => t.token_hash)).toEqual(["h-9700-next-null"]);
    expect(await countOpenedLogs(P)).toBe(0); // period is "unopened" again

    // scoped to one period: the neighbouring period keeps its bill AND its opened marker
    expect(await countPayments(P_NEXT)).toBe(1);
    expect(await countOpenedLogs(P_NEXT)).toBe(1);
  });

  // The overdue slot is claimed once per (workspace, period, day) after #48. If a mis-opened period
  // had already sent a reminder (one or more days), leaving those rows behind would silently mute
  // overdue reminders forever after a re-open — sendOverdueForPeriod just reports already_sent, no error.
  it("releases the overdue dedup slots (all days), scoped to this workspace+period", async () => {
    expect(await countOverdueLogs(WS, P)).toBe(0);        // both the '' slot and the dated slot are gone
    expect(await countOverdueLogs(WS, P_NEXT)).toBe(1);   // another period of the same workspace
    expect(await countOverdueLogs(WS_OTHER, P)).toBe(1);  // the same period of another workspace

    // the slot is genuinely free again, not merely absent from a COUNT
    expect(await claimNotification(env.DB, { workspaceId: WS, type: "overdue", period: P })).toBe(true);
  });

  // Uses its own period so it stays independent of the retract sequence the other tests share.
  it("clears the period's receipt and nudge slots so a re-open can announce again", async () => {
    const P2 = "2031-09";
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO notification_logs (workspace_id,type,period,plan_id,user_id,subscription_id,event,sent_at) VALUES (?,?,?,?,?,?,?,?)`).bind(WS, "billing_opened", P2, 0, 0, 0, "", TS),
      env.DB.prepare(`INSERT INTO notification_logs (workspace_id,type,period,plan_id,user_id,subscription_id,event,sent_at) VALUES (?,?,?,?,?,?,?,?)`).bind(WS, "receipt", P2, 0, U, S_PEND, "reject", TS),
      env.DB.prepare(`INSERT INTO notification_logs (workspace_id,type,period,plan_id,user_id,subscription_id,event,sent_at) VALUES (?,?,?,?,?,?,?,?)`).bind(WS, "receipt", P2, 0, U, S_PEND, "verify", TS),
      env.DB.prepare(`INSERT INTO notification_logs (workspace_id,type,period,plan_id,user_id,subscription_id,event,sent_at) VALUES (?,?,?,?,?,?,?,?)`).bind(WS, "nudge", P2, 0, U, 0, "", TS),
    ]);
    await retractPeriodBilling(env, WS, P2, { dryRun: false });
    const left = await env.DB.prepare("SELECT COUNT(*) c FROM notification_logs WHERE workspace_id=? AND period=?")
      .bind(WS, P2).first<{ c: number }>();
    expect(left!.c).toBe(0);
  });

  it("leaves the period unopened, so reconcile no longer refills it", async () => {
    const d = await reconcilePeriodBills(env, WS, P, { dryRun: false });
    expect(d.opened).toBe(false);
    expect(d.add).toEqual([]);
    expect(await countPayments(P)).toBe(2); // still just the two frozen bills
  });

  it("re-opening the period bills the cleared subs again without duplicating the frozen ones", async () => {
    await env.DB.prepare(`INSERT INTO notification_logs (workspace_id,type,period,plan_id,user_id,subscription_id,sent_at) VALUES (?,?,?,?,?,?,?)`)
      .bind(WS, "billing_opened", P, 0, 0, 0, TS).run();
    const active = (await env.DB.prepare("SELECT id FROM subscriptions WHERE workspace_id=? AND status='active'").bind(WS).all<{ id: number }>()).results;
    for (const s of active) await ensurePeriodPayment(env.DB, s.id, P);

    const rows = (await env.DB.prepare("SELECT subscription_id sid, status, amount FROM payments WHERE workspace_id=? AND period=?")
      .bind(WS, P).all<{ sid: number; status: string; amount: number }>()).results;
    expect(rows).toHaveLength(4); // 4 active subs, exactly one bill each; the cancelled sub is not re-billed
    const bySub = new Map(rows.map((x) => [x.sid, x]));
    expect(bySub.get(S_PEND)).toMatchObject({ status: "pending", amount: 320 }); // freshly re-opened
    expect(bySub.get(S_REJ)).toMatchObject({ status: "pending", amount: 320 });
    expect(bySub.get(S_PAID)).toMatchObject({ status: "paid", amount: 315 });    // untouched, not duplicated
    expect(bySub.get(S_VER)).toMatchObject({ status: "verified", amount: 315 });
  });
});

// Apply must not trust the preview snapshot. Bills can appear between preview and apply (the cron,
// or another admin's 發起繳費), and two retracts can land on the same period.
// Fresh band for this block: workspace/plan 9710, subs 971xx.
describe("retractPeriodBilling apply is set-based and reports real work", () => {
  const W = 9710, PL = 9710, UU = 97101;
  const PER = "2028-01", PER_RACE = "2028-02";
  const S_A = 97101, S_LATE = 97102, S_FROZEN = 97103;

  beforeAll(async () => {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO workspaces (id,name,owner_id,channel_type,billing_day,settings,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(W,"W2","o","discord",5,"{}",TS,TS),
      env.DB.prepare(`INSERT INTO plans (id,workspace_id,name,provider,monthly_amount,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`).bind(PL,W,"GPT","openai",300,TS,TS),
      env.DB.prepare(`INSERT INTO users (id,workspace_id,display_name,created_at,updated_at) VALUES (?,?,?,?,?)`).bind(UU,W,"U2",TS,TS),
      env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`).bind(S_A,W,UU,PL,"2027-01-01",5,"active",TS,TS),
      env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`).bind(S_LATE,W,UU,PL,"2027-01-01",5,"active",TS,TS),
      env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`).bind(S_FROZEN,W,UU,PL,"2027-01-01",5,"active",TS,TS),
      env.DB.prepare(`INSERT INTO notification_logs (workspace_id,type,period,plan_id,user_id,subscription_id,sent_at) VALUES (?,?,?,?,?,?,?)`).bind(W,"billing_opened",PER,0,0,0,TS),
      env.DB.prepare(`INSERT INTO notification_logs (workspace_id,type,period,plan_id,user_id,subscription_id,sent_at) VALUES (?,?,?,?,?,?,?)`).bind(W,"billing_opened",PER_RACE,0,0,0,TS),
      env.DB.prepare(`INSERT INTO payments (workspace_id,subscription_id,period,period_start,period_end,due_date,amount,status,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).bind(W,S_A,PER,`${PER}-01`,`${PER}-31`,`${PER}-05`,300,"pending","cron",TS,TS),
      env.DB.prepare(`INSERT INTO payments (workspace_id,subscription_id,period,period_start,period_end,due_date,amount,status,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).bind(W,S_FROZEN,PER,`${PER}-01`,`${PER}-31`,`${PER}-05`,300,"verified","admin_manual",TS,TS),
    ]);
  });

  it("deletes bills the preview never saw, and reports the real count", async () => {
    const preview = await retractPeriodBilling(env, W, PER, { dryRun: true });
    expect(preview.removed.map((r) => r.subscription_id)).toEqual([S_A]); // S_LATE has no bill yet
    expect(preview.frozen_count).toBe(1);

    // after the preview the cron bills S_LATE for the same period — the admin is looking at a
    // 1-row preview while the period now holds 2 unpaid bills
    await ensurePeriodPayment(env.DB, S_LATE, PER);
    expect(await env.DB.prepare("SELECT id FROM payments WHERE subscription_id=? AND period=?").bind(S_LATE, PER).first()).not.toBeNull();

    const r = await retractPeriodBilling(env, W, PER, { dryRun: false });
    // counts come from the batch's meta.changes, so they describe the DB's work, not the preview
    expect(r.applied).toMatchObject({ removed: 2, frozen: 1, marker_cleared: true });

    const rows = (await env.DB.prepare("SELECT subscription_id sid, status FROM payments WHERE workspace_id=? AND period=?").bind(W, PER).all<{ sid: number; status: string }>()).results;
    expect(rows).toEqual([{ sid: S_FROZEN, status: "verified" }]); // no unpaid bill left inside an unopened period
  });

  it("a second sequential apply is an honest no-op", async () => {
    const r = await retractPeriodBilling(env, W, PER, { dryRun: false });
    expect(r.opened).toBe(false);   // marker already gone
    expect(r.applied).toBeUndefined(); // nothing was applied, so nothing is claimed
    expect(r.removed).toEqual([]);
  });

  it("only one of two concurrent applies may claim the retract", async () => {
    const both = await Promise.all([
      retractPeriodBilling(env, W, PER_RACE, { dryRun: false }),
      retractPeriodBilling(env, W, PER_RACE, { dryRun: false }),
    ]);
    // Holds under either interleaving: a single marker row can only be deleted once, so exactly one
    // call is entitled to write the audit — whether the loser no-ops early or loses the marker DELETE.
    expect(both.filter((r) => r.applied?.marker_cleared).length).toBe(1);
    const left = await env.DB.prepare("SELECT COUNT(*) c FROM notification_logs WHERE workspace_id=? AND type='billing_opened' AND period=?")
      .bind(W, PER_RACE).first<{ c: number }>();
    expect(left!.c).toBe(0);
  });
});

// A period can hold unpaid bills WITHOUT ever having been opened: 新增訂閱 / 匯入名單 call
// ensureFirstPayment, which bills the start_date's month directly and never claims billing_opened.
// Those bills are unpayable (members' pay button keys off the marker) and — before this block —
// unclearable in bulk, because retract refused to touch an unopened period. That is the state the
// duplicate-subscription bug left behind, so retract must be able to clean it.
// Fresh band: workspace/plan 9720, user 97201, subs 972xx.
describe("retractPeriodBilling clears an unopened period's accidental bills", () => {
  const W = 9720, PL = 9720, UU = 97201;
  const PER = "2029-03";                       // never opened: no billing_opened row anywhere below
  const S_DUP1 = 97201, S_DUP2 = 97202, S_PAID2 = 97203, S_ACTIVE = 97204;

  const countOpened = async () => (await env.DB.prepare(
    "SELECT COUNT(*) c FROM notification_logs WHERE workspace_id=? AND type='billing_opened' AND period=?"
  ).bind(W, PER).first<{ c: number }>())!.c;

  beforeAll(async () => {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO workspaces (id,name,owner_id,channel_type,billing_day,settings,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(W,"W3","o","discord",1,"{}",TS,TS),
      env.DB.prepare(`INSERT INTO plans (id,workspace_id,name,provider,monthly_amount,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`).bind(PL,W,"GPT","openai",999,TS,TS),
      env.DB.prepare(`INSERT INTO users (id,workspace_id,display_name,discord_id,created_at,updated_at) VALUES (?,?,?,?,?,?)`).bind(UU,W,"重複成員","disc-9720",TS,TS),
      // three subscriptions of the SAME member+plan — the duplicate-click shape from the bug report
      env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`).bind(S_DUP1,W,UU,PL,`${PER}-01`,1,"active",TS,TS),
      env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`).bind(S_DUP2,W,UU,PL,`${PER}-01`,1,"active",TS,TS),
      env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`).bind(S_PAID2,W,UU,PL,`${PER}-01`,1,"active",TS,TS),
      env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`).bind(S_ACTIVE,W,UU,PL,`${PER}-01`,1,"active",TS,TS),
    ]);
    // exactly what routes/admin.ts createSubscription does after the INSERT
    for (const s of [S_DUP1, S_DUP2, S_PAID2]) await ensureFirstPayment(env.DB, s);
    // one of them was already settled by hand — settled money must survive a retract (#40)
    await env.DB.prepare("UPDATE payments SET status='paid', paid_at=? WHERE subscription_id=? AND period=?").bind(TS, S_PAID2, PER).run();
  });

  it("previews the unpayable bills instead of pretending there is nothing to do", async () => {
    expect(await countOpened()).toBe(0); // precondition: the period was never opened
    const r = await retractPeriodBilling(env, W, PER, { dryRun: true });
    expect(r.opened).toBe(false); // no marker — and that is precisely the case that used to be unreachable
    expect(new Set(r.removed.map((x) => x.subscription_id))).toEqual(new Set([S_DUP1, S_DUP2]));
    expect(r.frozen_count).toBe(1);
    // a preview still writes nothing
    const c = (await env.DB.prepare("SELECT COUNT(*) c FROM payments WHERE workspace_id=? AND period=?").bind(W, PER).first<{ c: number }>())!.c;
    expect(c).toBe(3);
  });

  it("apply deletes them, freezes the paid one, and never invents a marker it did not clear", async () => {
    const r = await retractPeriodBilling(env, W, PER, { dryRun: false });
    expect(r.applied).toMatchObject({ removed: 2, frozen: 1, marker_cleared: false });
    const rows = (await env.DB.prepare("SELECT subscription_id sid, status FROM payments WHERE workspace_id=? AND period=?")
      .bind(W, PER).all<{ sid: number; status: string }>()).results;
    expect(rows).toEqual([{ sid: S_PAID2, status: "paid" }]);
    expect(await countOpened()).toBe(0); // still unopened; the retract did not "close" anything
  });

  it("is an honest no-op once only settled bills remain", async () => {
    const r = await retractPeriodBilling(env, W, PER, { dryRun: false });
    expect(r.opened).toBe(false);
    expect(r.removed).toEqual([]);
    expect(r.applied).toBeUndefined(); // nothing happened → the route must not audit
  });

  // The gate loosening is retract-only. reconcile's `add` path CREATES bills; letting it run on an
  // unopened period would pre-bill months nobody opened — the hazard billing_opened exists to stop.
  it("does not loosen reconcile: an unopened period is still left alone", async () => {
    const d = await reconcilePeriodBills(env, W, PER, { dryRun: false });
    expect(d.opened).toBe(false);
    expect(d.add).toEqual([]);
    const c = (await env.DB.prepare("SELECT COUNT(*) c FROM payments WHERE workspace_id=? AND period=?").bind(W, PER).first<{ c: number }>())!.c;
    expect(c).toBe(1); // still just the frozen bill — no bill was created for S_ACTIVE
  });
});
