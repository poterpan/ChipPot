import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { parseRosterCsv, importRoster } from "../../src/core/import";

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
