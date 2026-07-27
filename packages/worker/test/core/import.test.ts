import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { parseRosterCsv, importRoster, type ImportDiff } from "../../src/core/import";

const CSV = `姓名,帳號,ChatGPT,Claude Standard,Claude Premium
Alice,alice@example.com,TRUE,FALSE,TRUE
Bob,bob@example.com,FALSE,TRUE,FALSE
,blank@example.com,TRUE,FALSE,FALSE

Carol,carol@example.com,true,false,false`;

describe("parseRosterCsv", () => {
  it("extracts name, email, TRUE plans and explicitly-FALSE plans (case-insensitive); skips blank lines", () => {
    const rows = parseRosterCsv(CSV);
    expect(rows.length).toBe(4);
    expect(rows[0]).toEqual({ name: "Alice", email: "alice@example.com", plans: ["ChatGPT", "Claude Premium"], plansOff: ["Claude Standard"] });
    expect(rows[1]).toEqual({ name: "Bob", email: "bob@example.com", plans: ["Claude Standard"], plansOff: ["ChatGPT", "Claude Premium"] });
    expect(rows[2]).toEqual({ name: "", email: "blank@example.com", plans: ["ChatGPT"], plansOff: ["Claude Standard", "Claude Premium"] });
    expect(rows[3]).toEqual({ name: "Carol", email: "carol@example.com", plans: ["ChatGPT"], plansOff: ["Claude Standard", "Claude Premium"] }); // lowercase true/false count
  });

  it("leaves blank and non-boolean cells out of BOTH lists (they mean 'untouched')", () => {
    const rows = parseRosterCsv("姓名,帳號,ChatGPT,Claude Standard,Claude Premium\nDana,dana@example.com,,1,FALSE");
    expect(rows[0]).toEqual({ name: "Dana", email: "dana@example.com", plans: [], plansOff: ["Claude Premium"] });
  });

  it("returns [] for empty or header-only input", () => {
    expect(parseRosterCsv("")).toEqual([]);
    expect(parseRosterCsv("姓名,帳號,ChatGPT")).toEqual([]);
  });
});

const TS = "2026-05-01T00:00:00.000Z";
const WS = 9028;
const PLAN_GPT = 9028, PLAN_STD = 90281;

beforeAll(async () => {
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO workspaces (id,name,owner_id,channel_type,billing_day,settings,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(WS, "W", "o", "discord", 5, "{}", TS, TS),
    env.DB.prepare(`INSERT INTO plans (id,workspace_id,name,provider,monthly_amount,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`).bind(PLAN_GPT, WS, "ChatGPT", "openai", 315, TS, TS),
    env.DB.prepare(`INSERT INTO plans (id,workspace_id,name,provider,monthly_amount,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`).bind(PLAN_STD, WS, "Claude Standard", "anthropic", 251, TS, TS),
    env.DB.prepare(`INSERT INTO users (id,workspace_id,display_name,email,discord_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`).bind(WS, WS, "Old Name", "amy@x.tw", "disc-amy", TS, TS),
    env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(WS, WS, WS, PLAN_GPT, "2026-06-01", 5, TS, TS),
  ]);
});

describe("importRoster", () => {
  it("upserts by email (keeps discord_id), creates subs + first payments, reports unmatched plans", async () => {
    const rows = [
      { name: "Amy New", email: "amy@x.tw", plans: ["ChatGPT", "Claude Standard"], plansOff: [] },
      { name: "Ben", email: "ben@x.tw", plans: ["Claude Standard", "Gemini"], plansOff: [] },
      { name: "NoEmail", email: "", plans: ["ChatGPT"], plansOff: [] },
    ];
    const d = await importRoster(env, WS, rows, { startDate: "2026-06-01", dryRun: false });
    expect(d.dry_run).toBe(false);
    expect(d.period).toBe("2026-06");
    expect(d.users_created.map((u) => u.email)).toEqual(["ben@x.tw"]);
    expect(d.users_created[0]!.user_id).toBeGreaterThan(0); // filled in by the apply pass
    expect(d.users_updated).toBe(1);
    expect(d.subs_added.map((s) => s.plan_name).sort()).toEqual(["Claude Standard", "Claude Standard"]);
    expect(d.subs_added.every((s) => s.subscription_id !== null)).toBe(true);
    expect(d.subs_skipped).toBe(1);   // Amy already has an active ChatGPT sub
    expect(d.rows_skipped).toBe(1);   // the row with no email
    expect(d.unmatched_plans).toEqual(["Gemini"]);
    expect(d.subs_paused).toEqual([]);
    expect(d.subs_reactivated).toEqual([]);
    expect(d.cancelled_conflicts).toEqual([]);
    expect(d.affected_pending_bills).toEqual([]);

    const amy = await env.DB.prepare("SELECT display_name, discord_id FROM users WHERE email='amy@x.tw'").first<{ display_name: string; discord_id: string }>();
    expect(amy).toMatchObject({ display_name: "Amy New", discord_id: "disc-amy" });

    const ben = await env.DB.prepare("SELECT id FROM users WHERE email='ben@x.tw'").first<{ id: number }>();
    const pay = await env.DB.prepare(
      `SELECT p.status FROM payments p JOIN subscriptions s ON s.id=p.subscription_id WHERE s.user_id=? AND p.period='2026-06'`
    ).bind(ben!.id).first<{ status: string }>();
    expect(pay?.status).toBe("pending");
  });

  it("is idempotent on a re-run (no new users/subs)", async () => {
    const rows = [{ name: "Amy New", email: "amy@x.tw", plans: ["ChatGPT", "Claude Standard"], plansOff: [] }];
    const d = await importRoster(env, WS, rows, { startDate: "2026-06-01", dryRun: false });
    expect(d.users_created).toEqual([]);
    expect(d.users_updated).toBe(1);
    expect(d.subs_added).toEqual([]);
    expect(d.subs_skipped).toBe(2);
  });

  it("merges duplicate rows for the same email into one member (no double insert)", async () => {
    const rows = [
      { name: "", email: "dupe@x.tw", plans: ["ChatGPT"], plansOff: [] },
      { name: "Dupe Later", email: "dupe@x.tw", plans: ["ChatGPT", "Claude Standard"], plansOff: [] },
    ];
    const d = await importRoster(env, WS, rows, { startDate: "2026-06-01", dryRun: false });
    expect(d.users_created.length).toBe(1);
    expect(d.subs_added.map((s) => s.plan_name).sort()).toEqual(["ChatGPT", "Claude Standard"]);
    const n = await env.DB.prepare("SELECT COUNT(*) c FROM users WHERE workspace_id=? AND email='dupe@x.tw'").bind(WS).first<{ c: number }>();
    expect(n?.c).toBe(1);
    const u = await env.DB.prepare("SELECT id, display_name FROM users WHERE workspace_id=? AND email='dupe@x.tw'").bind(WS).first<{ id: number; display_name: string }>();
    expect(u!.display_name).toBe("Dupe Later"); // the last non-empty name in the CSV wins
    const subs = await env.DB.prepare("SELECT COUNT(*) c FROM subscriptions WHERE workspace_id=? AND user_id=?").bind(WS, u!.id).first<{ c: number }>();
    expect(subs?.c).toBe(2);
  });
});

// dryRun must compute exactly the same diff while writing nothing. Own workspace: storage is
// isolated per FILE, so this fixture must not collide with the WS=9028 rows above.
describe("importRoster dryRun", () => {
  // U_OLD sits above the users AUTOINCREMENT high-water mark: the describes above insert members
  // without an explicit id, and the first of those takes 9029 (one past the WS=9028 fixture).
  const W = 9029, PL = 9029, U_OLD = 90291;
  beforeAll(async () => {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO workspaces (id,name,owner_id,channel_type,billing_day,settings,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(W, "W", "o", "discord", 5, "{}", TS, TS),
      env.DB.prepare(`INSERT INTO plans (id,workspace_id,name,provider,monthly_amount,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`).bind(PL, W, "ChatGPT", "openai", 315, TS, TS),
      env.DB.prepare(`INSERT INTO users (id,workspace_id,display_name,email,created_at,updated_at) VALUES (?,?,?,?,?,?)`).bind(U_OLD, W, "Old", "old@x.tw", TS, TS),
    ]);
  });

  it("reports what it would do and writes nothing", async () => {
    const rows = [
      { name: "Old Renamed", email: "old@x.tw", plans: ["ChatGPT"], plansOff: [] },
      { name: "Fresh", email: "fresh@x.tw", plans: ["ChatGPT"], plansOff: [] },
    ];
    const d = await importRoster(env, W, rows, { startDate: "2026-06-01", dryRun: true });
    expect(d.dry_run).toBe(true);
    expect(d.users_created).toEqual([{ user_id: null, user_name: "Fresh", email: "fresh@x.tw" }]);
    expect(d.users_updated).toBe(1);
    expect(d.subs_added.length).toBe(2);
    expect(d.subs_added.every((s) => s.subscription_id === null)).toBe(true);
    expect(d.subs_added[0]).toMatchObject({ plan_id: PL, plan_name: "ChatGPT", amount: 315 });

    const users = await env.DB.prepare("SELECT COUNT(*) c FROM users WHERE workspace_id=?").bind(W).first<{ c: number }>();
    expect(users?.c).toBe(1);                 // "Fresh" was NOT inserted
    const name = await env.DB.prepare("SELECT display_name FROM users WHERE id=?").bind(U_OLD).first<{ display_name: string }>();
    expect(name?.display_name).toBe("Old");   // the rename was NOT written
    const subs = await env.DB.prepare("SELECT COUNT(*) c FROM subscriptions WHERE workspace_id=?").bind(W).first<{ c: number }>();
    expect(subs?.c).toBe(0);
  });
});

// FALSE = un-subscribe → pause (reversible; the owner chose paused over cancelled). Own workspace:
// storage is isolated per FILE, so ids/emails must not collide with the blocks above. Every id here
// is derived as W*10+n, above the AUTOINCREMENT high-water marks the describes above leave behind
// (users 90291, subscriptions 9032) — an import that INSERTs raises those, so nothing low is safe.
describe("importRoster FALSE pauses an active subscription", () => {
  const W = 9030, PL_A = 90300, PL_B = 90301;
  const U = 90302, S_ACTIVE = 90303, S_KEEP = 90304, P = "2026-06";
  const PAY_OFF = 90305, PAY_KEEP = 90306;
  beforeAll(async () => {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO workspaces (id,name,owner_id,channel_type,billing_day,settings,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(W, "W", "o", "discord", 5, "{}", TS, TS),
      env.DB.prepare(`INSERT INTO plans (id,workspace_id,name,provider,monthly_amount,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`).bind(PL_A, W, "ChatGPT", "openai", 315, TS, TS),
      env.DB.prepare(`INSERT INTO plans (id,workspace_id,name,provider,monthly_amount,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`).bind(PL_B, W, "Claude Standard", "anthropic", 251, TS, TS),
      env.DB.prepare(`INSERT INTO users (id,workspace_id,display_name,email,created_at,updated_at) VALUES (?,?,?,?,?,?)`).bind(U, W, "退訂者", "off@x.tw", TS, TS),
      env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`).bind(S_ACTIVE, W, U, PL_A, "2026-01-01", 5, "active", TS, TS),
      env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`).bind(S_KEEP, W, U, PL_B, "2026-01-01", 5, "active", TS, TS),
      env.DB.prepare(`INSERT INTO payments (id,workspace_id,subscription_id,period,period_start,period_end,due_date,amount,status,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).bind(PAY_OFF, W, S_ACTIVE, P, `${P}-01`, `${P}-30`, `${P}-05`, 315, "pending", "cron", TS, TS),
      env.DB.prepare(`INSERT INTO payments (id,workspace_id,subscription_id,period,period_start,period_end,due_date,amount,status,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).bind(PAY_KEEP, W, S_KEEP, P, `${P}-01`, `${P}-30`, `${P}-05`, 251, "pending", "cron", TS, TS),
    ]);
  });

  // FALSE on ChatGPT, nothing at all for Claude Standard (absent from the header → untouched).
  const rows = () => [{ name: "退訂者", email: "off@x.tw", plans: [], plansOff: ["ChatGPT"] }];

  it("dry run reports the pause + this period's unpaid bill, and writes nothing", async () => {
    const d = await importRoster(env, W, rows(), { startDate: `${P}-01`, dryRun: true });
    expect(d.subs_paused.map((s) => s.subscription_id)).toEqual([S_ACTIVE]);
    expect(d.subs_paused[0]).toMatchObject({ user_name: "退訂者", plan_name: "ChatGPT", amount: 315 });
    expect(d.affected_pending_bills).toEqual([
      { payment_id: PAY_OFF, subscription_id: S_ACTIVE, user_name: "退訂者", plan_name: "ChatGPT", period: P, amount: 315, status: "pending" },
    ]);
    const s = await env.DB.prepare("SELECT status FROM subscriptions WHERE id=?").bind(S_ACTIVE).first<{ status: string }>();
    expect(s?.status).toBe("active"); // dry run wrote nothing
  });

  it("apply pauses only the FALSE sub, leaves every payment row untouched", async () => {
    const d = await importRoster(env, W, rows(), { startDate: `${P}-01`, dryRun: false });
    expect(d.subs_paused.map((s) => s.subscription_id)).toEqual([S_ACTIVE]);
    expect(d.affected_pending_bills.map((b) => b.payment_id)).toEqual([PAY_OFF]);

    const a = await env.DB.prepare("SELECT status FROM subscriptions WHERE id=?").bind(S_ACTIVE).first<{ status: string }>();
    expect(a?.status).toBe("paused");
    const keep = await env.DB.prepare("SELECT status FROM subscriptions WHERE id=?").bind(S_KEEP).first<{ status: string }>();
    expect(keep?.status).toBe("active"); // plan column absent from the CSV header → never touched

    // Report-only: the paused sub's bill is still exactly where it was.
    const bills = (await env.DB.prepare("SELECT id, status, amount FROM payments WHERE workspace_id=? AND period=? ORDER BY id").bind(W, P).all<{ id: number; status: string; amount: number }>()).results;
    expect(bills.map((b) => b.id)).toEqual([PAY_OFF, PAY_KEEP]);
    expect(bills[0]).toMatchObject({ status: "pending", amount: 315 });
  });

  it("a paused sub is not re-paused and reports no bills on a re-run", async () => {
    const d = await importRoster(env, W, rows(), { startDate: `${P}-01`, dryRun: false });
    expect(d.subs_paused).toEqual([]);
    expect(d.affected_pending_bills).toEqual([]);
  });

  it("a FALSE column whose plan name matches nothing is reported as unmatched", async () => {
    const d = await importRoster(env, W, [{ name: "退訂者", email: "off@x.tw", plans: [], plansOff: ["Gemini"] }], { startDate: `${P}-01`, dryRun: true });
    expect(d.unmatched_plans).toEqual(["Gemini"]);
    expect(d.subs_paused).toEqual([]);
  });
});

// The reverse path: TRUE next to a non-active sub. paused → reactivate; cancelled → conflict only
// (cancelling is a deliberate manual act) and, critically, NO duplicate subscription is inserted.
// Ids: fresh 9031x band. Everything above is at or below 9030x, and an importRoster INSERT raises
// the AUTOINCREMENT counters, so nothing lower than the marks the earlier describes leave behind
// (users 90302, subscriptions 90304, payments 90306) can be reused.
describe("importRoster TRUE on paused / cancelled subscriptions", () => {
  const W = 9031, PL = 90310;
  const U_PAUSED = 90311, U_CANCEL = 90312;
  const S_PAUSED = 90313, S_CANCEL = 90314, P = "2026-06";
  beforeAll(async () => {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO workspaces (id,name,owner_id,channel_type,billing_day,settings,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(W, "W", "o", "discord", 5, "{}", TS, TS),
      env.DB.prepare(`INSERT INTO plans (id,workspace_id,name,provider,monthly_amount,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`).bind(PL, W, "ChatGPT", "openai", 315, TS, TS),
      env.DB.prepare(`INSERT INTO users (id,workspace_id,display_name,email,created_at,updated_at) VALUES (?,?,?,?,?,?)`).bind(U_PAUSED, W, "回來了", "back@x.tw", TS, TS),
      env.DB.prepare(`INSERT INTO users (id,workspace_id,display_name,email,created_at,updated_at) VALUES (?,?,?,?,?,?)`).bind(U_CANCEL, W, "已取消", "gone@x.tw", TS, TS),
      // start_date is months before the import period on purpose: it proves reactivation does NOT
      // call ensureFirstPayment (which would bill 2026-01, a long-closed period).
      env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`).bind(S_PAUSED, W, U_PAUSED, PL, "2026-01-01", 5, "paused", TS, TS),
      env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`).bind(S_CANCEL, W, U_CANCEL, PL, "2026-01-01", 5, "cancelled", TS, TS),
    ]);
  });

  const rows = () => [
    { name: "回來了", email: "back@x.tw", plans: ["ChatGPT"], plansOff: [] },
    { name: "已取消", email: "gone@x.tw", plans: ["ChatGPT"], plansOff: [] },
  ];

  it("dry run reports one reactivation + one cancelled conflict, and writes nothing", async () => {
    const d = await importRoster(env, W, rows(), { startDate: `${P}-01`, dryRun: true });
    expect(d.subs_reactivated.map((s) => s.subscription_id)).toEqual([S_PAUSED]);
    expect(d.subs_reactivated[0]).toMatchObject({ user_name: "回來了", plan_name: "ChatGPT", amount: 315 });
    expect(d.cancelled_conflicts.map((s) => s.subscription_id)).toEqual([S_CANCEL]);
    expect(d.cancelled_conflicts[0]).toMatchObject({ user_name: "已取消", plan_name: "ChatGPT", amount: 315 });
    expect(d.subs_added).toEqual([]);   // the cancelled sub must NOT become a second subscription
    expect(d.subs_skipped).toBe(0);
    const st = await env.DB.prepare("SELECT status FROM subscriptions WHERE id=?").bind(S_PAUSED).first<{ status: string }>();
    expect(st?.status).toBe("paused");  // dry run wrote nothing
  });

  it("apply reactivates the paused sub without creating any payment row", async () => {
    await importRoster(env, W, rows(), { startDate: `${P}-01`, dryRun: false });
    const st = await env.DB.prepare("SELECT status FROM subscriptions WHERE id=?").bind(S_PAUSED).first<{ status: string }>();
    expect(st?.status).toBe("active");
    // No bill anywhere: not for the sub's old start month, not for the import period. The current
    // period's bill is 重新同步本期帳單's job (reconcilePeriodBills).
    const pays = await env.DB.prepare("SELECT COUNT(*) c FROM payments WHERE subscription_id=?").bind(S_PAUSED).first<{ c: number }>();
    expect(pays?.c).toBe(0);
  });

  it("apply leaves the cancelled sub cancelled and inserts no duplicate", async () => {
    await importRoster(env, W, rows(), { startDate: `${P}-01`, dryRun: false });
    const rowsOut = (await env.DB.prepare("SELECT id, status FROM subscriptions WHERE workspace_id=? AND user_id=?").bind(W, U_CANCEL).all<{ id: number; status: string }>()).results;
    expect(rowsOut).toEqual([{ id: S_CANCEL, status: "cancelled" }]);
    // Same thing counted by user+plan: the old "else INSERT" path would have added a second row here.
    const n = await env.DB.prepare("SELECT COUNT(*) c FROM subscriptions WHERE workspace_id=? AND user_id=? AND plan_id=?").bind(W, U_CANCEL, PL).first<{ c: number }>();
    expect(n?.c).toBe(1);
  });

  it("after reactivation a re-run just skips the now-active sub", async () => {
    const d = await importRoster(env, W, rows(), { startDate: `${P}-01`, dryRun: true });
    expect(d.subs_reactivated).toEqual([]);
    expect(d.subs_skipped).toBe(1);
    expect(d.cancelled_conflicts.length).toBe(1); // the cancelled one still needs a human
  });
});

// Contradictory cells for the same member+plan (two plan columns of the same name, or two CSV rows
// with the same email): a TRUE anywhere wins over a FALSE, so nothing is paused. Fresh 9041x band.
describe("importRoster TRUE wins over FALSE for the same plan", () => {
  const W = 9041, PL = 90410, U = 90411, S = 90412, PAY = 90413, P = "2026-06";
  beforeAll(async () => {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO workspaces (id,name,owner_id,channel_type,billing_day,settings,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(W, "W", "o", "discord", 5, "{}", TS, TS),
      env.DB.prepare(`INSERT INTO plans (id,workspace_id,name,provider,monthly_amount,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`).bind(PL, W, "ChatGPT", "openai", 315, TS, TS),
      env.DB.prepare(`INSERT INTO users (id,workspace_id,display_name,email,created_at,updated_at) VALUES (?,?,?,?,?,?)`).bind(U, W, "自相矛盾", "both@x.tw", TS, TS),
      env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`).bind(S, W, U, PL, "2026-01-01", 5, "active", TS, TS),
      env.DB.prepare(`INSERT INTO payments (id,workspace_id,subscription_id,period,period_start,period_end,due_date,amount,status,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).bind(PAY, W, S, P, `${P}-01`, `${P}-30`, `${P}-05`, 315, "pending", "cron", TS, TS),
    ]);
  });

  // Every assertion an un-filtered pause would break: the sub itself, both diff arrays, and the
  // report-only bill list (a pause would drag this period's unpaid bill into the preview).
  const expectUntouched = async (d: ImportDiff) => {
    expect(d.subs_paused).toEqual([]);
    expect(d.subs_added).toEqual([]);
    expect(d.subs_reactivated).toEqual([]);
    expect(d.subs_skipped).toBe(1);            // TRUE next to an already-active sub
    expect(d.affected_pending_bills).toEqual([]);
    const st = await env.DB.prepare("SELECT status FROM subscriptions WHERE id=?").bind(S).first<{ status: string }>();
    expect(st?.status).toBe("active");
    const n = await env.DB.prepare("SELECT COUNT(*) c FROM subscriptions WHERE workspace_id=? AND user_id=? AND plan_id=?").bind(W, U, PL).first<{ c: number }>();
    expect(n?.c).toBe(1);
    const bill = await env.DB.prepare("SELECT status, amount FROM payments WHERE id=?").bind(PAY).first<{ status: string; amount: number }>();
    expect(bill).toMatchObject({ status: "pending", amount: 315 });
  };

  it("TRUE + FALSE for the same plan in ONE row leaves the sub active", async () => {
    const d = await importRoster(env, W, [{ name: "自相矛盾", email: "both@x.tw", plans: ["ChatGPT"], plansOff: ["ChatGPT"] }], { startDate: `${P}-01`, dryRun: false });
    await expectUntouched(d);
  });

  it("a FALSE row followed by a TRUE row for the same email also leaves the sub active", async () => {
    // FALSE first: the pause is queued before the TRUE is even read, so this only passes if the
    // filter runs after the whole CSV has been merged, not per row.
    const d = await importRoster(env, W, [
      { name: "自相矛盾", email: "both@x.tw", plans: [], plansOff: ["ChatGPT"] },
      { name: "自相矛盾", email: "both@x.tw", plans: ["ChatGPT"], plansOff: [] },
    ], { startDate: `${P}-01`, dryRun: false });
    await expectUntouched(d);
  });
});

// affected_pending_bills is report-only AND narrow: exactly THIS period's pending/rejected bills of
// the subs being paused. Four subs of one member, each paused by a FALSE, each with a different bill
// so every arm of the `p.period = ? AND p.status IN ('pending','rejected')` filter is pinned.
// Fresh 9051x band.
describe("importRoster affected_pending_bills period + status filter", () => {
  const W = 9051;
  const PL_REJ = 90510, PL_OLD = 90511, PL_PAID = 90512, PL_VER = 90513;
  const U = 90514;
  const S_REJ = 90515, S_OLD = 90516, S_PAID = 90517, S_VER = 90518;
  const PAY_REJ = 90519, PAY_OLD = 90520, PAY_PAID = 90521, PAY_VER = 90522;
  const P = "2026-06", P_OLD = "2026-05";
  const pay = (id: number, sub: number, period: string, amount: number, status: string) =>
    env.DB.prepare(`INSERT INTO payments (id,workspace_id,subscription_id,period,period_start,period_end,due_date,amount,status,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(id, W, sub, period, `${period}-01`, `${period}-28`, `${period}-05`, amount, status, "cron", TS, TS);
  const sub = (id: number, plan: number) =>
    env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`)
      .bind(id, W, U, plan, "2026-01-01", 5, "active", TS, TS);
  const plan = (id: number, name: string, amount: number) =>
    env.DB.prepare(`INSERT INTO plans (id,workspace_id,name,provider,monthly_amount,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`).bind(id, W, name, "openai", amount, TS, TS);

  beforeAll(async () => {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO workspaces (id,name,owner_id,channel_type,billing_day,settings,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(W, "W", "o", "discord", 5, "{}", TS, TS),
      plan(PL_REJ, "ChatGPT", 315), plan(PL_OLD, "Claude Standard", 251), plan(PL_PAID, "Claude Premium", 500), plan(PL_VER, "Gemini Pro", 100),
      env.DB.prepare(`INSERT INTO users (id,workspace_id,display_name,email,created_at,updated_at) VALUES (?,?,?,?,?,?)`).bind(U, W, "四訂閱", "bills@x.tw", TS, TS),
      sub(S_REJ, PL_REJ), sub(S_OLD, PL_OLD), sub(S_PAID, PL_PAID), sub(S_VER, PL_VER),
      pay(PAY_REJ, S_REJ, P, 315, "rejected"),      // this period, still owed → LISTED
      pay(PAY_OLD, S_OLD, P_OLD, 251, "pending"),   // older period, real debt → not listed
      pay(PAY_PAID, S_PAID, P, 500, "paid"),        // this period, already settled → not listed
      pay(PAY_VER, S_VER, P, 100, "verified"),      // this period, already verified → not listed
    ]);
  });

  // Every plan FALSE → all four subs get paused, so the bill list is the only thing being filtered.
  const rows = () => [{ name: "四訂閱", email: "bills@x.tw", plans: [], plansOff: ["ChatGPT", "Claude Standard", "Claude Premium", "Gemini Pro"] }];

  it("lists a 'rejected' current-period bill of a newly-paused sub", async () => {
    const d = await importRoster(env, W, rows(), { startDate: `${P}-01`, dryRun: true });
    expect(d.subs_paused.map((s) => s.subscription_id)).toEqual([S_REJ, S_OLD, S_PAID, S_VER]);
    expect(d.affected_pending_bills).toEqual([
      { payment_id: PAY_REJ, subscription_id: S_REJ, user_name: "四訂閱", plan_name: "ChatGPT", period: P, amount: 315, status: "rejected" },
    ]);
  });

  it("excludes an older period's unpaid bill and this period's paid/verified bills", async () => {
    // The excluded rows really are in the DB — without this the exclusions below could pass on an
    // empty fixture.
    const all = (await env.DB.prepare("SELECT id, period, status FROM payments WHERE workspace_id=? ORDER BY id").bind(W).all<{ id: number; period: string; status: string }>()).results;
    expect(all).toEqual([
      { id: PAY_REJ, period: P, status: "rejected" },
      { id: PAY_OLD, period: P_OLD, status: "pending" },
      { id: PAY_PAID, period: P, status: "paid" },
      { id: PAY_VER, period: P, status: "verified" },
    ]);

    const d = await importRoster(env, W, rows(), { startDate: `${P}-01`, dryRun: true });
    const ids = d.affected_pending_bills.map((b) => b.payment_id);
    expect(ids).toEqual([PAY_REJ]);
    expect(ids).not.toContain(PAY_OLD);  // 2026-05 pending is real debt, not a stale bill
    expect(ids).not.toContain(PAY_PAID);
    expect(ids).not.toContain(PAY_VER);
  });
});

// dryRun:true then dryRun:false over the SAME rows must describe the same work: the preview the
// admin approves is what the apply does. Only the ids that don't exist until the INSERT may differ.
// Fresh 9061x band; this is the one block whose apply pass inserts (auto ids land above 9061x).
describe("importRoster dry run and apply agree on the same rows", () => {
  const W = 9061, PL_A = 90610, PL_B = 90611;
  const U_OFF = 90612, U_BACK = 90613, U_GONE = 90614;
  const S_ACTIVE = 90615, S_PAUSED = 90616, S_CANCELLED = 90617, PAY = 90618, P = "2026-06";
  beforeAll(async () => {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO workspaces (id,name,owner_id,channel_type,billing_day,settings,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(W, "W", "o", "discord", 5, "{}", TS, TS),
      env.DB.prepare(`INSERT INTO plans (id,workspace_id,name,provider,monthly_amount,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`).bind(PL_A, W, "ChatGPT", "openai", 315, TS, TS),
      env.DB.prepare(`INSERT INTO plans (id,workspace_id,name,provider,monthly_amount,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`).bind(PL_B, W, "Claude Standard", "anthropic", 251, TS, TS),
      env.DB.prepare(`INSERT INTO users (id,workspace_id,display_name,email,created_at,updated_at) VALUES (?,?,?,?,?,?)`).bind(U_OFF, W, "停用者", "d-off@x.tw", TS, TS),
      env.DB.prepare(`INSERT INTO users (id,workspace_id,display_name,email,created_at,updated_at) VALUES (?,?,?,?,?,?)`).bind(U_BACK, W, "回歸者", "d-back@x.tw", TS, TS),
      env.DB.prepare(`INSERT INTO users (id,workspace_id,display_name,email,created_at,updated_at) VALUES (?,?,?,?,?,?)`).bind(U_GONE, W, "取消者", "d-cancel@x.tw", TS, TS),
      env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`).bind(S_ACTIVE, W, U_OFF, PL_A, "2026-01-01", 5, "active", TS, TS),
      env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`).bind(S_PAUSED, W, U_BACK, PL_B, "2026-01-01", 5, "paused", TS, TS),
      env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`).bind(S_CANCELLED, W, U_GONE, PL_A, "2026-01-01", 5, "cancelled", TS, TS),
      env.DB.prepare(`INSERT INTO payments (id,workspace_id,subscription_id,period,period_start,period_end,due_date,amount,status,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).bind(PAY, W, S_ACTIVE, P, `${P}-01`, `${P}-30`, `${P}-05`, 315, "pending", "cron", TS, TS),
    ]);
  });

  // One row per outcome, so a single diff comparison covers every array at once.
  const rows = () => [
    { name: "停用者", email: "d-off@x.tw", plans: [], plansOff: ["ChatGPT"] },              // pause
    { name: "回歸者", email: "d-back@x.tw", plans: ["Claude Standard"], plansOff: [] },      // reactivate
    { name: "取消者", email: "d-cancel@x.tw", plans: ["ChatGPT"], plansOff: [] },            // conflict
    { name: "新人", email: "d-new@x.tw", plans: ["Claude Standard", "Gemini"], plansOff: [] }, // add + unmatched
    { name: "無信箱", email: "", plans: ["ChatGPT"], plansOff: [] },                         // rows_skipped
  ];

  // The only legitimate differences: the dry_run flag, and the ids a dry run cannot know because
  // the row isn't inserted yet (documented `number | null` on ImportUserLine/ImportSubLine).
  const comparable = (d: ImportDiff) => {
    const { dry_run: _flag, ...rest } = d;
    return {
      ...rest,
      users_created: rest.users_created.map((u) => ({ ...u, user_id: null })),
      subs_added: rest.subs_added.map((s) => ({ ...s, subscription_id: null, user_id: null })),
    };
  };

  it("produces the same diff apart from the ids that only exist after the INSERT", async () => {
    const dry = await importRoster(env, W, rows(), { startDate: `${P}-01`, dryRun: true });
    const applied = await importRoster(env, W, rows(), { startDate: `${P}-01`, dryRun: false });

    expect(dry.dry_run).toBe(true);
    expect(applied.dry_run).toBe(false);
    expect(comparable(applied)).toEqual(comparable(dry));

    // Not a comparison of two empty diffs: this is the work both passes described.
    expect(dry.subs_paused.map((s) => s.subscription_id)).toEqual([S_ACTIVE]);
    expect(dry.subs_reactivated.map((s) => s.subscription_id)).toEqual([S_PAUSED]);
    expect(dry.cancelled_conflicts.map((s) => s.subscription_id)).toEqual([S_CANCELLED]);
    expect(dry.subs_added.map((s) => s.plan_name)).toEqual(["Claude Standard"]);
    expect(dry.users_created.map((u) => u.email)).toEqual(["d-new@x.tw"]);
    expect(dry.users_updated).toBe(3);
    expect(dry.rows_skipped).toBe(1);
    expect(dry.unmatched_plans).toEqual(["Gemini"]);
    expect(dry.affected_pending_bills.map((b) => b.payment_id)).toEqual([PAY]);

    // The normalized-away fields, asserted in the one direction each pass allows.
    expect(dry.users_created.map((u) => u.user_id)).toEqual([null]);
    expect(dry.subs_added.map((s) => s.subscription_id)).toEqual([null]);
    expect(applied.users_created[0]!.user_id).toBeGreaterThan(0);
    expect(applied.subs_added[0]!.subscription_id).toBeGreaterThan(0);
    expect(applied.subs_added[0]!.user_id).toBe(applied.users_created[0]!.user_id);
  });

  it("wrote exactly what the dry run promised", async () => {
    const subs = (await env.DB.prepare("SELECT id, status FROM subscriptions WHERE workspace_id=? AND id IN (?,?,?) ORDER BY id").bind(W, S_ACTIVE, S_PAUSED, S_CANCELLED).all<{ id: number; status: string }>()).results;
    expect(subs).toEqual([
      { id: S_ACTIVE, status: "paused" },
      { id: S_PAUSED, status: "active" },
      { id: S_CANCELLED, status: "cancelled" },
    ]);
    const added = (await env.DB.prepare("SELECT s.id, s.plan_id, s.status FROM subscriptions s JOIN users u ON u.id=s.user_id WHERE u.email='d-new@x.tw'").all<{ id: number; plan_id: number; status: string }>()).results;
    expect(added.length).toBe(1);
    expect(added[0]).toMatchObject({ plan_id: PL_B, status: "active" });

    // The new sub gets its first bill; the paused sub's bill is left exactly as it was.
    const newBill = await env.DB.prepare("SELECT period, status FROM payments WHERE subscription_id=?").bind(added[0]!.id).first<{ period: string; status: string }>();
    expect(newBill).toMatchObject({ period: P, status: "pending" });
    const oldBill = await env.DB.prepare("SELECT status, amount FROM payments WHERE id=?").bind(PAY).first<{ status: string; amount: number }>();
    expect(oldBill).toMatchObject({ status: "pending", amount: 315 });
  });
});
