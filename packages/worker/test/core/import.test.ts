import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { parseRosterCsv, importRoster } from "../../src/core/import";

const CSV = `姓名,帳號,ChatGPT,Claude Standard,Claude Premium
潘柏嘉,poter.pan@x.tw,TRUE,FALSE,TRUE
柯艾妤,aiiiii@x.tw,FALSE,TRUE,FALSE
,blank@x.tw,TRUE,FALSE,FALSE

陳怡晶,chingching@x.tw,true,false,false`;

describe("parseRosterCsv", () => {
  it("extracts name, email, and TRUE plan columns (case-insensitive); skips blank lines", () => {
    const rows = parseRosterCsv(CSV);
    expect(rows.length).toBe(4);
    expect(rows[0]).toEqual({ name: "潘柏嘉", email: "poter.pan@x.tw", plans: ["ChatGPT", "Claude Premium"] });
    expect(rows[1]).toEqual({ name: "柯艾妤", email: "aiiiii@x.tw", plans: ["Claude Standard"] });
    expect(rows[2]).toEqual({ name: "", email: "blank@x.tw", plans: ["ChatGPT"] });
    expect(rows[3]).toEqual({ name: "陳怡晶", email: "chingching@x.tw", plans: ["ChatGPT"] }); // lowercase "true" counts
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
      { name: "Amy New", email: "amy@x.tw", plans: ["ChatGPT", "Claude Standard"] },
      { name: "Ben", email: "ben@x.tw", plans: ["Claude Standard", "Gemini"] },
      { name: "NoEmail", email: "", plans: ["ChatGPT"] },
    ];
    const s = await importRoster(env, WS, rows, { startDate: "2026-06-01" });
    expect(s).toMatchObject({ usersCreated: 1, usersUpdated: 1, subsCreated: 2, subsSkipped: 1, rowsSkipped: 1 });
    expect(s.unmatchedPlans).toEqual(["Gemini"]);

    const amy = await env.DB.prepare("SELECT display_name, discord_id FROM users WHERE email='amy@x.tw'").first<{ display_name: string; discord_id: string }>();
    expect(amy).toMatchObject({ display_name: "Amy New", discord_id: "disc-amy" });

    const ben = await env.DB.prepare("SELECT id FROM users WHERE email='ben@x.tw'").first<{ id: number }>();
    const pay = await env.DB.prepare(
      `SELECT p.status FROM payments p JOIN subscriptions s ON s.id=p.subscription_id WHERE s.user_id=? AND p.period='2026-06'`
    ).bind(ben!.id).first<{ status: string }>();
    expect(pay?.status).toBe("pending");
  });

  it("is idempotent on a re-run (no new users/subs)", async () => {
    const rows = [{ name: "Amy New", email: "amy@x.tw", plans: ["ChatGPT", "Claude Standard"] }];
    const s = await importRoster(env, WS, rows, { startDate: "2026-06-01" });
    expect(s).toMatchObject({ usersCreated: 0, usersUpdated: 1, subsCreated: 0, subsSkipped: 2 });
  });
});
